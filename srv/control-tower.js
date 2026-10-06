// =============================================================================
// Control Tower read functions (registered on ReturnsService)
// -----------------------------------------------------------------------------
// Read-only OData v4 functions for the Reclaim Control Tower. Each one reads
// from DS4 with GET requests only and answers with a JSON string:
//
//   GET /odata/v4/returns/listBlockedOrders(top=500)
//   -> { "value": "{\"underlyingRequests\":[...],\"capturedOn\":\"2026-10-06\",\"response\":{...}}" }
//
// "response" has the same shape as the organizers' MCP tools (mock pack), so
// the Reclaim loader can read live answers unchanged. "underlyingRequests"
// lists every SAP call made, for the request log on the Control Tower.
//
// Output conventions:
//   dates           YYYY-MM-DD (SAP sends /Date(ms)/)
//   amounts         strings with 2 decimals ("10800.00"), currency next to them
//   document numbers  leading zeros stripped ("0000001876" -> "1876")
//
// The functions, with the L4 step of the Control Tower table they feed and its owner:
//
//   #  function                    L4             owner (agent)          SAP API (all GET)
//   1  listUnbilledDeliveries      4.1.1          7 Billing Gatekeeper   API_OUTBOUND_DELIVERY_SRV;v=0002
//   2  listDeliveriesAwaitingPod   3.4.1          6 POD Chaser           API_OUTBOUND_DELIVERY_SRV;v=0002
//   3  listBlockedOrders           2.3.3 · 4.1.4  3 Block Buster         API_SALES_ORDER_SRV
//   4  listOverdueReceivables      6.1.2          9 Cash Application     FAR_CUSTOMER_LINE_ITEMS
//   5  listBillingDueList          4.1.1          7 Billing Gatekeeper   SD_CUSTOMER_INVOICES_CREATE
//   6  getCustomerAddresses        (map, names)   –                      API_BUSINESS_PARTNER
//   7  checkOrderConformance       one order: order -> delivery -> invoice, findings per L4 step
//   8  listReturnsWithoutCredit    5.2.1          8 Returns & Credit     API_CUSTOMER_RETURN_SRV
//
// Severity and grouping are applied by Reclaim, except where noted (3-day POD
// grace, 7-day return age, findings of checkOrderConformance).
//
// There are deliberately no actions here: the Control Tower must have no write path.
// =============================================================================

const SAP_CLIENT = '100';
const MAX_TOP = 500;          // Upper limit for the "top" parameter
const PAGE_SIZE = 100;        // Rows per SAP request when paging with $skip
const DUE_LIST_PAGE = 25;     // Billing due list: small pages, so one unreadable row costs little
const GRACE_DAYS_POD = 3;     // Deliveries shipped in the last 3 days are not yet "awaiting POD"
const RETURN_CREDIT_DAYS = 7;  // A return older than this without a credit memo is a finding (5.2.1)
const DAY_MS = 24 * 60 * 60 * 1000;

const DELIVERY_PATH = '/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV;v=0002';
const SALES_ORDER_PATH = '/sap/opu/odata/sap/API_SALES_ORDER_SRV';
const BILLING_PATH = '/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV';
const RECEIVABLES_PATH = '/sap/opu/odata/sap/FAR_CUSTOMER_LINE_ITEMS';
const DUE_LIST_PATH = '/sap/opu/odata/sap/SD_CUSTOMER_INVOICES_CREATE';
const PARTNER_PATH = '/sap/opu/odata/sap/API_BUSINESS_PARTNER';
const RETURN_PATH = '/sap/opu/odata/sap/API_CUSTOMER_RETURN_SRV';

// Company code currency, used when SAP returns no line items to take it from
const COMPANY_CODE_CURRENCY = { YDE1: 'EUR', YRO1: 'RON' };

// ---- Input checks (values end up in OData URLs) ----
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9]{1,10}$/.test(v);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// ---- Output formatting ----
const today = () => new Date().toISOString().slice(0, 10);

// '/Date(1790640000000)/' or '/Date(1790679696741+0000)/' -> '2026-09-29'; ISO strings are cut to the date
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const ms = /\/Date\((-?\d+)/.exec(v);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// '0000001876' -> '1876'; non-numeric values (e.g. 'YOR') are left alone
const noZeros = (v) => (typeof v === 'string' && /^\d+$/.test(v) ? v.replace(/^0+(?=\d)/, '') : v);

// '10800' / 10800 / '10800.0' -> '10800.00'
const toAmount = (v) => (v === null || v === undefined || v === '' ? null : Number(v).toFixed(2));

// Whole days between a YYYY-MM-DD date and today (UTC)
const daysSince = (date) => (date ? Math.floor((Date.parse(today()) - Date.parse(date)) / DAY_MS) : null);

// SAP booleans come as true/false or 'X'/''
const toBool = (v) => v === true || v === 'X' || v === 'true';

// Clamp "top" to 1..MAX_TOP; null means the parameter was invalid
function toTop(v, fallback) {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_TOP) : null;
}

const daysAgo = (n) => new Date(Date.parse(today()) - n * DAY_MS).toISOString().slice(0, 10);

const orFilter = (field, values) => values.map((v) => `${field} eq '${v}'`).join(' or ');

module.exports = function registerControlTower(srv, { callDestination, handleError, unwrap }) {
  // ---- SAP reads, recorded for "underlyingRequests" ----
  // params: [[name, value], ...]; values are URL-encoded for the call but kept
  // readable in the trace.
  async function get(trace, path, params = []) {
    const all = [...params, ['$format', 'json'], ['sap-client', SAP_CLIENT]];
    const readable = all.map(([k, v]) => `${k}=${v}`).join('&');
    const encoded = all.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    trace.push(`GET ${path}?${readable}`);
    const response = await callDestination('GET', `${path}?${encoded}`);
    return unwrap(response.data);
  }

  // Reads up to "top" rows, PAGE_SIZE at a time, until a page comes back short
  async function getAll(trace, path, params, top, pageSize = PAGE_SIZE) {
    const rows = [];
    while (rows.length < top) {
      const size = Math.min(pageSize, top - rows.length);
      const page = (await get(trace, path, [...params, ['$top', size], ['$skip', rows.length]])).results || [];
      rows.push(...page);
      if (page.length < size) break;
    }
    return rows;
  }

  // An invoice plus its cancellation is not an invoice: returns the cancelled invoices and the
  // cancellation documents among billingKeys. A header SAP does not return counts as in force.
  async function notInForce(trace, billingKeys) {
    if (!billingKeys.length) return new Set();
    const headers = await getAll(trace, `${BILLING_PATH}/A_BillingDocument`,
      [['$filter', orFilter('BillingDocument', billingKeys)],
        ['$select', 'BillingDocument,BillingDocumentIsCancelled,CancelledBillingDocument']], 1000, 1000);
    return new Set(headers
      .filter((h) => toBool(h.BillingDocumentIsCancelled) || h.CancelledBillingDocument)
      .map((h) => noZeros(h.BillingDocument)));
  }

  // Wraps a handler: runs it with a fresh trace and returns the JSON envelope.
  // Any SAP error becomes a proper HTTP error, so Reclaim marks the section "not read".
  function readFunction(name, body) {
    srv.on(name, async (req) => {
      const trace = [];
      try {
        const response = await body(req, trace);
        return JSON.stringify({ underlyingRequests: trace, capturedOn: today(), response });
      } catch (err) {
        // req.reject (bad input) throws as well: keep its 400 instead of turning it into a SAP error
        if (!err.response && !err.isAxiosError) throw err;
        return handleError(req, err, name);
      }
    });
  }

  // ---- 1 · listUnbilledDeliveries: goods issued, not (fully) billed ----
  readFunction('listUnbilledDeliveries', async (req, trace) => {
    const top = toTop(req.data.top, MAX_TOP);
    const { soldToParty } = req.data;
    if (top === null) return req.reject(400, `top must be a whole number between 1 and ${MAX_TOP}`);
    if (soldToParty && !isId(soldToParty)) return req.reject(400, 'soldToParty must be 1–10 letters or digits');

    let filter = "OverallGoodsMovementStatus eq 'C' and " +
      "(OverallDelivReltdBillgStatus eq 'A' or OverallDelivReltdBillgStatus eq 'B')";
    if (soldToParty) filter += ` and SoldToParty eq '${soldToParty}'`;

    const rows = await getAll(trace, `${DELIVERY_PATH}/A_OutbDeliveryHeader`,
      [['$filter', filter], ['$orderby', 'ActualGoodsMovementDate asc']], top);

    const deliveries = rows.map((d) => {
      const goodsIssue = toDate(d.ActualGoodsMovementDate);
      return {
        DeliveryDocument: noZeros(d.DeliveryDocument),
        SoldToParty: noZeros(d.SoldToParty),
        ShipToParty: noZeros(d.ShipToParty),
        ActualGoodsMovementDate: goodsIssue,
        OverallDelivReltdBillgStatus: d.OverallDelivReltdBillgStatus,
        DeliveryBlockReason: d.DeliveryBlockReason,
        SalesOrganization: d.SalesOrganization,
        daysSinceGoodsIssue: daysSince(goodsIssue)
      };
    });
    return { count: deliveries.length, deliveries };
  });

  // ---- 2 · listDeliveriesAwaitingPod: goods issued over 3 days ago, no proof of delivery ----
  readFunction('listDeliveriesAwaitingPod', async (req, trace) => {
    const top = toTop(req.data.top, MAX_TOP);
    const { shipToParty } = req.data;
    if (top === null) return req.reject(400, `top must be a whole number between 1 and ${MAX_TOP}`);
    if (shipToParty && !isId(shipToParty)) return req.reject(400, 'shipToParty must be 1–10 letters or digits');

    let filter = "OverallGoodsMovementStatus eq 'C' and " +
      "(OverallProofOfDeliveryStatus eq 'A' or OverallProofOfDeliveryStatus eq 'B') and " +
      `ActualGoodsMovementDate le datetime'${daysAgo(GRACE_DAYS_POD)}T00:00:00'`;
    if (shipToParty) filter += ` and ShipToParty eq '${shipToParty}'`;

    const rows = await getAll(trace, `${DELIVERY_PATH}/A_OutbDeliveryHeader`,
      [['$filter', filter], ['$orderby', 'ActualGoodsMovementDate asc']], top);

    const deliveries = rows.map((d) => {
      const goodsIssue = toDate(d.ActualGoodsMovementDate);
      return {
        DeliveryDocument: noZeros(d.DeliveryDocument),
        ShipToParty: noZeros(d.ShipToParty),
        ActualGoodsMovementDate: goodsIssue,
        daysSinceGoodsIssue: daysSince(goodsIssue),
        podFields: {
          OverallProofOfDeliveryStatus: d.OverallProofOfDeliveryStatus,
          ProofOfDeliveryDate: toDate(d.ProofOfDeliveryDate)
        }
      };
    });
    return { count: deliveries.length, deliveries };
  });

  // ---- 3 · listBlockedOrders: billing block, delivery block or credit block ----
  readFunction('listBlockedOrders', async (req, trace) => {
    const top = toTop(req.data.top, MAX_TOP);
    if (top === null) return req.reject(400, `top must be a whole number between 1 and ${MAX_TOP}`);

    const filter = "HeaderBillingBlockReason ne '' or DeliveryBlockReason ne '' or TotalCreditCheckStatus eq 'B'";
    const rows = await getAll(trace, `${SALES_ORDER_PATH}/A_SalesOrder`,
      [['$filter', filter], ['$orderby', 'TotalNetAmount desc']], top);

    const orders = rows.map((o) => ({
      SalesOrder: noZeros(o.SalesOrder),
      SalesOrderType: o.SalesOrderType,
      SalesOrganization: o.SalesOrganization,
      SoldToParty: noZeros(o.SoldToParty),
      CreationDate: toDate(o.CreationDate),
      TotalNetAmount: toAmount(o.TotalNetAmount),
      TransactionCurrency: o.TransactionCurrency,
      HeaderBillingBlockReason: o.HeaderBillingBlockReason,
      DeliveryBlockReason: o.DeliveryBlockReason,
      OverallSDProcessStatus: o.OverallSDProcessStatus,
      TotalCreditCheckStatus: o.TotalCreditCheckStatus
    }));
    return { count: orders.length, orders };
  });

  // ---- 4 · listOverdueReceivables: open items past their net due date, per customer ----
  readFunction('listOverdueReceivables', async (req, trace) => {
    const { companyCode } = req.data;
    const keyDate = req.data.keyDate || today();
    if (!isId(companyCode)) return req.reject(400, 'companyCode must be 1–10 letters or digits');
    if (!isDate(keyDate)) return req.reject(400, 'keyDate must be YYYY-MM-DD');

    const at = `datetime'${keyDate}T00:00:00'`;
    const filter = `KeyDate eq ${at} and CompanyCode eq '${companyCode}' and NetDueDate lt ${at} and ` +
      `(HasClearingAccountingDocument eq '' or ClearingDate gt ${at})`;
    // No row limit: every overdue item counts towards the total
    const rows = await getAll(trace, `${RECEIVABLES_PATH}/Items`,
      [['$filter', filter], ['$select', 'Customer,AmountInCompanyCodeCurrency,CompanyCodeCurrency']],
      Number.MAX_SAFE_INTEGER, 5000);

    // Sum in cents to avoid floating point drift
    const perCustomer = new Map();
    for (const r of rows) {
      const customer = noZeros(r.Customer);
      const cents = Math.round(Number(r.AmountInCompanyCodeCurrency || 0) * 100);
      perCustomer.set(customer, (perCustomer.get(customer) || 0) + cents);
    }
    const currency = rows[0]?.CompanyCodeCurrency || COMPANY_CODE_CURRENCY[companyCode] || null;
    const topCustomers = [...perCustomer]
      .sort((a, b) => b[1] - a[1])
      .map(([Customer, cents]) => ({
        Customer,
        AmountInCompanyCodeCurrency: (cents / 100).toFixed(2),
        CompanyCodeCurrency: currency
      }));
    const totalCents = [...perCustomer.values()].reduce((sum, c) => sum + c, 0);

    return {
      asOf: keyDate,
      overdueReceivables: { total: Number((totalCents / 100).toFixed(2)), currency, topCustomers }
    };
  });

  // ---- 5 · listBillingDueList: deliveries/orders due for billing for one customer ----
  readFunction('listBillingDueList', async (req, trace) => {
    const { soldToParty } = req.data;
    const top = toTop(req.data.top, 100);
    if (!isId(soldToParty)) return req.reject(400, 'soldToParty must be 1–10 letters or digits');
    if (top === null) return req.reject(400, `top must be a whole number between 1 and ${MAX_TOP}`);

    // This service answers 500 to $orderby, so the list is taken in SAP's order. It also
    // answers 500 for a whole page when one row in it is unreadable: such a page is read
    // again row by row, and the rows that still fail are skipped and counted.
    const path = `${DUE_LIST_PATH}/C_BillingDueListItem_F0798`;
    const params = [['$filter', `SoldToParty eq '${soldToParty}'`]];
    const is500 = (err) => err.response?.status === 500;
    const readPage = async (skip, size) =>
      (await get(trace, path, [...params, ['$top', size], ['$skip', skip]])).results || [];

    const rows = [];
    let skippedRows = 0;
    for (let skip = 0; rows.length < top;) {
      const size = Math.min(DUE_LIST_PAGE, top - rows.length);
      let page;
      let failed = 0;
      try {
        page = await readPage(skip, size);
      } catch (err) {
        if (!is500(err)) throw err;
        page = [];
        for (let n = skip; n < skip + size; n++) {
          try {
            const one = await readPage(n, 1);
            if (!one.length) break;       // End of the list
            page.push(...one);
          } catch (rowErr) {
            if (!is500(rowErr)) throw rowErr;
            failed++;
          }
        }
      }
      rows.push(...page);
      skippedRows += failed;
      skip += page.length + failed;
      if (page.length + failed < size) break;   // Short page: the list has ended
    }

    const items = rows.map((i) => ({
      ReferenceSDDocument: noZeros(i.ReferenceSDDocument),
      NetAmount: toAmount(i.NetAmount),
      TransactionCurrency: i.TransactionCurrency,
      HasError: toBool(i.HasError),
      BillingDocumentDate: toDate(i.BillingDocumentDate),
      SoldToParty: noZeros(i.SoldToParty)
    }));
    return { total: items.length, items, skippedRows };
  });

  // ---- 6 · getCustomerAddresses: country/city and name per business partner ----
  readFunction('getCustomerAddresses', async (req, trace) => {
    const partners = [...new Set(String(req.data.partners || '').split(',').map((p) => p.trim()).filter(Boolean))];
    if (!partners.length || partners.length > 100 || !partners.every(isId)) {
      return req.reject(400, 'partners must be a comma-separated list of 1–100 business partner numbers');
    }

    const filter = orFilter('BusinessPartner', partners);
    const [addressRows, nameRows, norwayRows] = await Promise.all([
      getAll(trace, `${PARTNER_PATH}/A_BusinessPartnerAddress`,
        [['$filter', filter], ['$select', 'BusinessPartner,Country,CityName']], 1000, 1000),
      getAll(trace, `${PARTNER_PATH}/A_BusinessPartner`,
        [['$filter', filter], ['$select', 'BusinessPartner,BusinessPartnerFullName']], 1000, 1000),
      getAll(trace, `${PARTNER_PATH}/A_BusinessPartnerAddress`,
        [['$filter', "Country eq 'NO'"], ['$select', 'BusinessPartner,Country,CityName']], 1000, 1000)
    ]);

    const address = (a) => ({ BusinessPartner: noZeros(a.BusinessPartner), CityName: a.CityName, Country: a.Country });
    const addresses = addressRows.map(address);
    const withAddress = new Set(addresses.map((a) => a.BusinessPartner));

    return {
      addresses,
      names: nameRows.map((n) => ({
        BusinessPartner: noZeros(n.BusinessPartner),
        BusinessPartnerFullName: n.BusinessPartnerFullName
      })),
      norway: norwayRows.map(address),
      noAddressOnDS4: partners.filter((p) => !withAddress.has(noZeros(p)))
    };
  });

  // ---- 7 · checkOrderConformance: has a sales order followed the O2C process? ----
  // Reads the order, its deliveries (delivery items that reference the order) and its
  // invoices (billing items that reference it), then reports deviations:
  //
  //   credit block on the order               -> 2.3.3  blocks   (always checked)
  //   delivered, not billed, and ...
  //     a delivery still waits for its POD     -> 3.4.1  pod      (POD is the cause)
  //     else a header or item billing block    -> 4.1.4  blocks
  //     else                                   -> 4.1.1  billing
  //
  // A delivered-but-unbilled order gives exactly one of the last three findings.
  // No delivery yet is not a deviation. Cancelled invoices do not count as billed.
  readFunction('checkOrderConformance', async (req, trace) => {
    const { salesOrder } = req.data;
    if (!isId(salesOrder)) return req.reject(400, 'salesOrder must be 1–10 letters or digits');

    // Reference fields may be stored with leading zeros: retry padded if nothing is found
    const byReference = async (path, field) => {
      const query = (n) => getAll(trace, path, [['$filter', `${field} eq '${n}'`]], 1000, 1000);
      const rows = await query(salesOrder);
      return rows.length || !/^\d{1,9}$/.test(salesOrder) ? rows : query(salesOrder.padStart(10, '0'));
    };

    const order = await get(trace, `${SALES_ORDER_PATH}/A_SalesOrder('${salesOrder}')`);
    const [deliveryItems, billingItems] = await Promise.all([
      byReference(`${DELIVERY_PATH}/A_OutbDeliveryItem`, 'ReferenceSDDocument'),
      byReference(`${BILLING_PATH}/A_BillingDocumentItem`, 'SalesDocument')
    ]);

    const deliveryKeys = [...new Set(deliveryItems.map((i) => i.DeliveryDocument))];
    const deliveries = deliveryKeys.map(noZeros);
    // Cancelled invoices and cancellation documents do not count as billed
    const billingKeys = [...new Set(billingItems.map((i) => i.BillingDocument))];
    const cancelled = await notInForce(trace, billingKeys);
    const billingDocuments = billingKeys.map(noZeros).filter((b) => !cancelled.has(b));

    // Delivered but not billed: read the POD status, because an open POD is the cause (3.4.1)
    let podOpen = [];
    if (deliveryKeys.length && !billingDocuments.length) {
      const headers = await getAll(trace, `${DELIVERY_PATH}/A_OutbDeliveryHeader`,
        [['$filter', orFilter('DeliveryDocument', deliveryKeys)],
          ['$select', 'DeliveryDocument,OverallProofOfDeliveryStatus']], 1000, 1000);
      podOpen = headers
        .filter((h) => ['A', 'B'].includes(h.OverallProofOfDeliveryStatus))
        .map((h) => noZeros(h.DeliveryDocument));
    }

    // Billing blocks: the header one (order) and item ones (delivery items, not shown on the due list)
    const billingBlocks = [
      ...(order.HeaderBillingBlockReason ? [`header block ${order.HeaderBillingBlockReason}`] : []),
      ...deliveryItems.filter((i) => i.ItemBillingBlockReason).map((i) =>
        `item block ${i.ItemBillingBlockReason} on delivery ${noZeros(i.DeliveryDocument)} item ${noZeros(i.DeliveryDocumentItem)}`)
    ];

    // Steps and wording follow the Control Tower's L4 table
    // (2.3.3 · 4.1.4 -> 3 Block Buster, 3.4.1 -> 6 POD Chaser, 4.1.1 -> 7 Billing Gatekeeper)
    const findings = [];
    if (order.TotalCreditCheckStatus === 'B') {
      findings.push({
        severity: 'medium',
        l4: '2.3.3',
        step: 'Remove billing block upon approval (VKM1)',
        finding: 'Credit block: needs a credit-limit decision (master data) by a person.',
        routeTo: 'blocks'
      });
    }
    // No delivery yet means nothing to deviate from; the grace period is applied by Reclaim.
    // One finding per order, by cause: POD open first, then billing block, else billing itself.
    if (deliveries.length && !billingDocuments.length && podOpen.length) {
      findings.push({
        severity: 'high',
        l4: '3.4.1',
        step: 'Request proof of delivery (POD) from the logistics provider (VL06P)',
        finding: `Goods issued, proof of delivery still open (${podOpen.join(', ')}): billing waits for POD.`,
        routeTo: 'pod'
      });
    } else if (deliveries.length && !billingDocuments.length && billingBlocks.length) {
      findings.push({
        severity: 'medium',
        l4: '4.1.4',
        step: 'Remove billing block (VA02)',
        finding: `Delivered but blocked for billing (${billingBlocks.join('; ')}): billing cannot proceed.`,
        routeTo: 'blocks'
      });
    } else if (deliveries.length && !billingDocuments.length) {
      findings.push({
        severity: 'high',
        l4: '4.1.1',
        step: 'Invoice Creation: Create billing document (VF01) based on delivery',
        finding: 'Delivered but not billed: revenue leakage risk.',
        routeTo: 'billing'
      });
    }

    return {
      salesOrder: noZeros(order.SalesOrder || salesOrder),
      conforms: findings.length === 0,
      deliveries,
      billingDocuments,
      findings
    };
  });

  // ---- 8 · listReturnsWithoutCredit: customer returns older than 7 days without a credit memo ----
  // The credit memo for a return is a billing document whose items point to the return
  // (SalesDocument). Cancelled credit memos do not count.
  readFunction('listReturnsWithoutCredit', async (req, trace) => {
    const top = toTop(req.data.top, MAX_TOP);
    const { soldToParty } = req.data;
    if (top === null) return req.reject(400, `top must be a whole number between 1 and ${MAX_TOP}`);
    if (soldToParty && !isId(soldToParty)) return req.reject(400, 'soldToParty must be 1–10 letters or digits');

    let filter = `CreationDate le datetime'${daysAgo(RETURN_CREDIT_DAYS)}T00:00:00'`;
    if (soldToParty) filter += ` and SoldToParty eq '${soldToParty}'`;
    const returns = (await getAll(trace, `${RETURN_PATH}/A_CustomerReturn`,
      [['$filter', filter], ['$orderby', 'CreationDate asc']], top))
      .filter((r) => r.OverallSDDocumentRejectionSts !== 'C');   // Fully rejected: nothing to credit

    // Billing items that reference the returns, 40 returns per request to keep the URL short
    const billingItems = [];
    for (let i = 0; i < returns.length; i += 40) {
      const keys = returns.slice(i, i + 40).map((r) => r.CustomerReturn);
      billingItems.push(...await getAll(trace, `${BILLING_PATH}/A_BillingDocumentItem`,
        [['$filter', orFilter('SalesDocument', keys)], ['$select', 'BillingDocument,SalesDocument']], 5000, 5000));
    }
    const cancelled = await notInForce(trace, [...new Set(billingItems.map((b) => b.BillingDocument))]);
    const credited = new Set(billingItems
      .filter((b) => !cancelled.has(noZeros(b.BillingDocument)))
      .map((b) => noZeros(b.SalesDocument)));

    const open = returns
      .filter((r) => !credited.has(noZeros(r.CustomerReturn)))
      .map((r) => {
        const created = toDate(r.CreationDate);
        return {
          CustomerReturn: noZeros(r.CustomerReturn),
          CustomerReturnType: r.CustomerReturnType,
          SalesOrganization: r.SalesOrganization,
          SoldToParty: noZeros(r.SoldToParty),
          CreationDate: created,
          daysSinceCreation: daysSince(created),
          TotalNetAmount: toAmount(r.TotalNetAmount),
          TransactionCurrency: r.TransactionCurrency,
          SDDocumentReason: r.SDDocumentReason,
          HeaderBillingBlockReason: r.HeaderBillingBlockReason,
          OverallSDProcessStatus: r.OverallSDProcessStatus
        };
      });
    return { count: open.length, returns: open };
  });
};

// Exported for unit tests
module.exports.toDate = toDate;
module.exports.noZeros = noZeros;
