// =============================================================================
// Tests for the Control Tower read functions (srv/control-tower.js)
// -----------------------------------------------------------------------------
// Same setup as returns-service.test.js: the CAP service runs in memory and
// the SAP Cloud SDK is mocked, so nothing reaches DS4. Calls go over HTTP GET,
// exactly like Reclaim calls them, so the { value: "<json>" } wrapper is tested too.
// =============================================================================

jest.mock('@sap-cloud-sdk/http-client', () => ({ executeHttpRequest: jest.fn() }));

const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const { GET } = cds.test(__dirname + '/..');

const BASE = '/odata/v4/returns';
const ms = (iso) => `/Date(${Date.parse(iso)})/`;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.parse(today()) - n * 86400000).toISOString().slice(0, 10);

// ---- Fake SAP backend: tests set "routes" (URL substring -> rows or function) ----
let routes;
let calls;
executeHttpRequest.mockImplementation(async (dest, { method, url }) => {
  calls.push({ method, url: decodeURIComponent(url) });
  const decoded = decodeURIComponent(url);
  for (const [part, answer] of Object.entries(routes)) {
    if (!decoded.includes(part)) continue;
    const d = typeof answer === 'function' ? answer(decoded) : { results: answer };
    if (d instanceof Error) throw d;
    return { data: { d }, headers: {} };
  }
  return { data: { d: { results: [] } }, headers: {} };
});
beforeEach(() => { routes = {}; calls = []; });

// Calls a function over HTTP and parses the JSON string in "value"
async function call(path) {
  const { data } = await GET(`${BASE}/${path}`);
  return JSON.parse(data.value);
}
const status = (path) => GET(`${BASE}/${path}`).then(() => 200, (e) => e.response.status);

// Simulates $top/$skip paging over a list of rows
const paged = (rows) => (url) => {
  const top = Number(/\$top=(\d+)/.exec(url)[1]);
  const skip = Number(/\$skip=(\d+)/.exec(url)?.[1] || 0);
  return { results: rows.slice(skip, skip + top) };
};

// The read-only promise: every Control Tower entry point must be a function (GET), never an action (POST)
describe('Control Tower: metadata', () => {
  test('all eight are functions (GET), none is an action', async () => {
    const { data } = await GET(`${BASE}/$metadata`);
    for (const name of ['listUnbilledDeliveries', 'listDeliveriesAwaitingPod', 'listBlockedOrders',
      'listOverdueReceivables', 'listBillingDueList', 'getCustomerAddresses', 'checkOrderConformance',
      'listReturnsWithoutCredit']) {
      expect(data).toMatch(new RegExp(`<Function Name="${name}"`));
      expect(data).not.toMatch(new RegExp(`<Action Name="${name}"`));
    }
  });
});

// Envelope, output formatting, paging, optional filter and error handling (shared by all functions)
describe('listUnbilledDeliveries', () => {
  test('envelope, formatting and paging until a short page', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      DeliveryDocument: String(80000000 + i).padStart(10, '0'),
      SoldToParty: '0000010044', ShipToParty: '0000010044',
      ActualGoodsMovementDate: ms(daysAgo(10)),
      OverallDelivReltdBillgStatus: 'A', DeliveryBlockReason: '', SalesOrganization: 'YSOD', Extra: 'x'
    }));
    routes = { A_OutbDeliveryHeader: paged(rows) };

    const out = await call('listUnbilledDeliveries(top=500)');

    expect(out.capturedOn).toBe(today());
    expect(out.response.count).toBe(150);
    expect(out.response.deliveries[0]).toEqual({
      DeliveryDocument: '80000000', SoldToParty: '10044', ShipToParty: '10044',
      ActualGoodsMovementDate: daysAgo(10), OverallDelivReltdBillgStatus: 'A',
      DeliveryBlockReason: '', SalesOrganization: 'YSOD', daysSinceGoodsIssue: 10
    });
    // Two pages: 100 rows, then 50 (short) -> stop
    expect(out.underlyingRequests).toHaveLength(2);
    expect(out.underlyingRequests[1]).toMatch(/^GET \/sap\/opu\/odata\/sap\/API_OUTBOUND_DELIVERY_SRV;v=0002\/A_OutbDeliveryHeader\?/);
    expect(out.underlyingRequests[1]).toContain('$skip=100');
    expect(out.underlyingRequests[1]).toContain('sap-client=100');
    expect(out.underlyingRequests[0]).toContain("OverallGoodsMovementStatus eq 'C' and (OverallDelivReltdBillgStatus eq 'A' or OverallDelivReltdBillgStatus eq 'B')");
    expect(out.underlyingRequests[0]).toContain('$orderby=ActualGoodsMovementDate asc');
    expect(out.underlyingRequests[0]).not.toContain('SoldToParty eq');
  });

  test('optional soldToParty is added to the filter; only GET requests reach SAP', async () => {
    const out = await call("listUnbilledDeliveries(top=5,soldToParty='10044')");
    expect(out.underlyingRequests[0]).toContain("and SoldToParty eq '10044'");
    expect(out.underlyingRequests[0]).toContain('$top=5');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  test('invalid input -> 400 without calling SAP', async () => {
    expect(await status('listUnbilledDeliveries(top=0)')).toBe(400);
    expect(await status("listUnbilledDeliveries(top=5,soldToParty='a%20or%201')")).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('SAP error -> HTTP error, not an empty list', async () => {
    routes = { A_OutbDeliveryHeader: () => Object.assign(new Error('boom'), { response: { status: 503, data: {} } }) };
    expect(await status('listUnbilledDeliveries(top=5)')).toBe(503);
  });
});

// The 3-day grace period is applied in the SAP filter
describe('listDeliveriesAwaitingPod', () => {
  test('filters on goods issue at least 3 days ago and returns POD fields', async () => {
    routes = {
      A_OutbDeliveryHeader: [{
        DeliveryDocument: '0080000001', ShipToParty: '0000010021', ActualGoodsMovementDate: ms(daysAgo(7)),
        OverallProofOfDeliveryStatus: 'A', ProofOfDeliveryDate: null
      }]
    };
    const out = await call('listDeliveriesAwaitingPod(top=500)');
    expect(out.underlyingRequests[0]).toContain(`ActualGoodsMovementDate le datetime'${daysAgo(3)}T00:00:00'`);
    expect(out.response).toEqual({
      count: 1,
      deliveries: [{
        DeliveryDocument: '80000001', ShipToParty: '10021', ActualGoodsMovementDate: daysAgo(7),
        daysSinceGoodsIssue: 7, podFields: { OverallProofOfDeliveryStatus: 'A', ProofOfDeliveryDate: null }
      }]
    });
  });
});

// Amount formatting and the three kinds of block in one filter
describe('listBlockedOrders', () => {
  test('amounts as 2-decimal strings next to the currency', async () => {
    routes = {
      A_SalesOrder: [{
        SalesOrder: '0000001876', SalesOrderType: 'YOR', SalesOrganization: 'YSOD', SoldToParty: '10044',
        CreationDate: ms('2026-09-01'), TotalNetAmount: '10800', TransactionCurrency: 'EUR',
        HeaderBillingBlockReason: '', DeliveryBlockReason: '01', OverallSDProcessStatus: 'A', TotalCreditCheckStatus: ''
      }]
    };
    const out = await call('listBlockedOrders(top=500)');
    expect(out.response.orders[0]).toMatchObject({
      SalesOrder: '1876', SalesOrderType: 'YOR', CreationDate: '2026-09-01',
      TotalNetAmount: '10800.00', TransactionCurrency: 'EUR'
    });
    expect(out.underlyingRequests[0]).toContain("HeaderBillingBlockReason ne '' or DeliveryBlockReason ne '' or TotalCreditCheckStatus eq 'B'");
    expect(out.underlyingRequests[0]).toContain('$orderby=TotalNetAmount desc');
  });
});

// Totals are summed in cents per customer; the currency falls back to the company code's
describe('listOverdueReceivables', () => {
  test('sums per customer, sorts descending, total as number', async () => {
    routes = {
      'FAR_CUSTOMER_LINE_ITEMS/Items': [
        { Customer: '0000010044', AmountInCompanyCodeCurrency: '300000.20', CompanyCodeCurrency: 'EUR' },
        { Customer: '0000010021', AmountInCompanyCodeCurrency: '50090.00', CompanyCodeCurrency: 'EUR' },
        { Customer: '0000010044', AmountInCompanyCodeCurrency: '18508.20', CompanyCodeCurrency: 'EUR' }
      ]
    };
    const out = await call("listOverdueReceivables(companyCode='YDE1',keyDate='2026-10-06')");
    expect(out.response).toEqual({
      asOf: '2026-10-06',
      overdueReceivables: {
        total: 368598.4,
        currency: 'EUR',
        topCustomers: [
          { Customer: '10044', AmountInCompanyCodeCurrency: '318508.40', CompanyCodeCurrency: 'EUR' },
          { Customer: '10021', AmountInCompanyCodeCurrency: '50090.00', CompanyCodeCurrency: 'EUR' }
        ]
      }
    });
    expect(out.underlyingRequests[0]).toContain(
      "KeyDate eq datetime'2026-10-06T00:00:00' and CompanyCode eq 'YDE1' and NetDueDate lt datetime'2026-10-06T00:00:00'");
    expect(out.underlyingRequests[0]).toContain('$select=Customer,AmountInCompanyCodeCurrency,CompanyCodeCurrency');
  });

  test('no overdue items: currency from the company code', async () => {
    const out = await call("listOverdueReceivables(companyCode='YRO1',keyDate='2026-10-06')");
    expect(out.response.overdueReceivables).toEqual({ total: 0, currency: 'RON', topCustomers: [] });
  });

  test('bad key date -> 400', async () => {
    expect(await status("listOverdueReceivables(companyCode='YDE1',keyDate='06.10.2026')")).toBe(400);
  });
});

// The due-list service rejects $orderby, so it must never be sent
describe('listBillingDueList', () => {
  test('maps items and never sends $orderby', async () => {
    routes = {
      C_BillingDueListItem_F0798: [{
        ReferenceSDDocument: '0080000123', NetAmount: '540', TransactionCurrency: 'EUR',
        HasError: false, BillingDocumentDate: ms('2026-10-01'), SoldToParty: '10044'
      }]
    };
    const out = await call("listBillingDueList(soldToParty='10044',top=100)");
    expect(out.response).toEqual({
      total: 1,
      items: [{
        ReferenceSDDocument: '80000123', NetAmount: '540.00', TransactionCurrency: 'EUR',
        HasError: false, BillingDocumentDate: '2026-10-01', SoldToParty: '10044'
      }],
      skippedRows: 0
    });
    expect(out.underlyingRequests[0]).not.toContain('$orderby');
  });
});

// DS4 answers 500 for a whole page if one row in it is unreadable: re-read row by row, skip and count
describe('listBillingDueList: unreadable rows', () => {
  test('a page with a bad row is re-read row by row; the bad row is skipped and counted', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ ReferenceSDDocument: String(80000100 + i), NetAmount: '1' }));
    const bad = 7;   // Row 7 breaks every request that includes it
    routes = {
      C_BillingDueListItem_F0798: (url) => {
        const top = Number(/\$top=(\d+)/.exec(url)[1]);
        const skip = Number(/\$skip=(\d+)/.exec(url)[1]);
        if (skip <= bad && bad < skip + top) return Object.assign(new Error('Data Services'), { response: { status: 500, data: {} } });
        return { results: rows.slice(skip, skip + top) };
      }
    };
    const out = await call("listBillingDueList(soldToParty='10021',top=100)");
    expect(out.response.skippedRows).toBe(1);
    expect(out.response.total).toBe(29);
    expect(out.response.items.map((i) => i.ReferenceSDDocument)).not.toContain('80000107');
    expect(out.underlyingRequests).toContain(
      "GET /sap/opu/odata/sap/SD_CUSTOMER_INVOICES_CREATE/C_BillingDueListItem_F0798?$filter=SoldToParty eq '10021'&$top=1&$skip=7&$format=json&sap-client=100");
  });

  test('an error other than 500 is not retried row by row: it stays an HTTP error', async () => {
    routes = { C_BillingDueListItem_F0798: () => Object.assign(new Error('down'), { response: { status: 503, data: {} } }) };
    expect(await status("listBillingDueList(soldToParty='10021')")).toBe(503);
  });
});

// 5.2.1: returns older than 7 days whose credit memo is missing or cancelled
describe('listReturnsWithoutCredit', () => {
  test('older than 7 days, keeps returns without a credit memo in force', async () => {
    routes = {
      A_CustomerReturn: [
        { CustomerReturn: '60000164', CustomerReturnType: 'YRE', SoldToParty: '0000010021', CreationDate: ms(daysAgo(20)),
          TotalNetAmount: '540', TransactionCurrency: 'EUR', SDDocumentReason: 'Z02', HeaderBillingBlockReason: '08' },
        { CustomerReturn: '60000165', SoldToParty: '10021', CreationDate: ms(daysAgo(15)) },   // credited
        { CustomerReturn: '60000166', SoldToParty: '10021', CreationDate: ms(daysAgo(10)) },   // credit memo cancelled
        { CustomerReturn: '60000167', SoldToParty: '10021', CreationDate: ms(daysAgo(9)), OverallSDDocumentRejectionSts: 'C' }
      ],
      A_BillingDocumentItem: [
        { BillingDocument: '0090000500', SalesDocument: '60000165' },
        { BillingDocument: '0090000501', SalesDocument: '60000166' }
      ],
      'A_BillingDocument?': [{ BillingDocument: '0090000501', BillingDocumentIsCancelled: true }]
    };
    const out = await call('listReturnsWithoutCredit(top=500)');
    expect(out.underlyingRequests[0]).toContain(
      `API_CUSTOMER_RETURN_SRV/A_CustomerReturn?$filter=CreationDate le datetime'${daysAgo(7)}T00:00:00'`);
    expect(out.underlyingRequests[0]).toContain('$orderby=CreationDate asc');
    expect(out.underlyingRequests[1]).toContain(
      "SalesDocument eq '60000164' or SalesDocument eq '60000165' or SalesDocument eq '60000166'");
    expect(out.response.count).toBe(2);
    expect(out.response.returns[0]).toEqual({
      CustomerReturn: '60000164', CustomerReturnType: 'YRE', SoldToParty: '10021',
      CreationDate: daysAgo(20), daysSinceCreation: 20, TotalNetAmount: '540.00', TransactionCurrency: 'EUR',
      SDDocumentReason: 'Z02', HeaderBillingBlockReason: '08'
    });
    expect(out.response.returns[1].CustomerReturn).toBe('60000166');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  test('optional soldToParty; bad input -> 400', async () => {
    const out = await call("listReturnsWithoutCredit(top=5,soldToParty='10021')");
    expect(out.underlyingRequests[0]).toContain("and SoldToParty eq '10021'");
    expect(out.response).toEqual({ count: 0, returns: [] });
    expect(await status("listReturnsWithoutCredit(soldToParty='a%20or%201')")).toBe(400);
  });
});

// Three reads in parallel; partners without an address are listed separately
describe('getCustomerAddresses', () => {
  test('addresses, names, Norway list and partners without address', async () => {
    routes = {
      "Country eq 'NO'": [{ BusinessPartner: '10101', Country: 'NO', CityName: 'Oslo' }],
      A_BusinessPartnerAddress: [
        { BusinessPartner: '10044', Country: 'DE', CityName: 'Berlin' },
        { BusinessPartner: '62', Country: 'RO', CityName: 'Bucuresti' }
      ],
      A_BusinessPartner: [{ BusinessPartner: '10044', BusinessPartnerFullName: 'Domestic Customer DE' }]
    };
    const out = await call("getCustomerAddresses(partners='10044,62,46,51')");
    expect(out.response).toEqual({
      addresses: [
        { BusinessPartner: '10044', CityName: 'Berlin', Country: 'DE' },
        { BusinessPartner: '62', CityName: 'Bucuresti', Country: 'RO' }
      ],
      names: [{ BusinessPartner: '10044', BusinessPartnerFullName: 'Domestic Customer DE' }],
      norway: [{ BusinessPartner: '10101', CityName: 'Oslo', Country: 'NO' }],
      noAddressOnDS4: ['46', '51']
    });
    expect(out.underlyingRequests).toHaveLength(3);
    expect(out.underlyingRequests[0]).toContain(
      "BusinessPartner eq '10044' or BusinessPartner eq '62' or BusinessPartner eq '46' or BusinessPartner eq '51'");
  });

  test('injection attempt in the list -> 400', async () => {
    expect(await status("getCustomerAddresses(partners='10044,1'' or ''1')")).toBe(400);
  });
});

// One order through order -> delivery -> invoice; which finding wins is tested case by case
describe('checkOrderConformance', () => {
  const order = (extra = {}) => () => ({ SalesOrder: '1876', TotalCreditCheckStatus: '', ...extra });

  test('no delivery yet -> conforms', async () => {
    routes = { "A_SalesOrder('1876')": order() };
    const out = await call("checkOrderConformance(salesOrder='1876')");
    expect(out.response).toEqual({ salesOrder: '1876', conforms: true, deliveries: [], billingDocuments: [], findings: [] });
  });

  test('delivered but not billed -> 4.1.1 finding routed to billing', async () => {
    routes = {
      "A_SalesOrder('1876')": order(),
      A_OutbDeliveryItem: [{ DeliveryDocument: '0080000001' }, { DeliveryDocument: '0080000001' }]
    };
    const out = await call("checkOrderConformance(salesOrder='1876')");
    expect(out.response.conforms).toBe(false);
    expect(out.response.deliveries).toEqual(['80000001']);
    expect(out.response.findings).toEqual([{
      severity: 'high', l4: '4.1.1',
      step: 'Invoice Creation: Create billing document (VF01) based on delivery',
      finding: 'Delivered but not billed: revenue leakage risk.', routeTo: 'billing'
    }]);
  });

  test('delivered and billed -> conforms; padded reference tried when unpadded finds nothing', async () => {
    routes = {
      "A_SalesOrder('1876')": order(),
      "ReferenceSDDocument eq '0000001876'": [{ DeliveryDocument: '80000001' }],
      A_BillingDocumentItem: [{ BillingDocument: '0090000376' }]
    };
    const out = await call("checkOrderConformance(salesOrder='1876')");
    expect(out.response).toMatchObject({ conforms: true, deliveries: ['80000001'], billingDocuments: ['90000376'] });
  });

  test('credit block -> 2.3.3 finding routed to blocks', async () => {
    routes = { "A_SalesOrder('1876')": order({ TotalCreditCheckStatus: 'B' }) };
    const out = await call("checkOrderConformance(salesOrder='1876')");
    expect(out.response.findings).toEqual([{
      severity: 'medium', l4: '2.3.3',
      step: 'Remove billing block upon approval (VKM1)',
      finding: 'Credit block: needs a credit-limit decision (master data) by a person.',
      routeTo: 'blocks'
    }]);
  });

  test('delivered, unbilled and POD open -> one 3.4.1 finding routed to pod', async () => {
    routes = {
      "A_SalesOrder('1876')": order({ HeaderBillingBlockReason: '02' }),
      A_OutbDeliveryItem: [{ DeliveryDocument: '0080000001' }, { DeliveryDocument: '0080000002' }],
      A_OutbDeliveryHeader: [
        { DeliveryDocument: '0080000001', OverallProofOfDeliveryStatus: 'A' },
        { DeliveryDocument: '0080000002', OverallProofOfDeliveryStatus: 'C' }
      ]
    };
    const out = await call("checkOrderConformance(salesOrder='1876')");
    expect(out.response.findings).toEqual([{
      severity: 'high', l4: '3.4.1',
      step: 'Request proof of delivery (POD) from the logistics provider (VL06P)',
      finding: 'Goods issued, proof of delivery still open (80000001): billing waits for POD.',
      routeTo: 'pod'
    }]);
    expect(out.underlyingRequests.find((r) => r.includes('A_OutbDeliveryHeader'))).toContain(
      "DeliveryDocument eq '0080000001' or DeliveryDocument eq '0080000002'");
  });

  test('delivered with billing block, POD done -> 4.1.4 finding routed to blocks', async () => {
    routes = {
      "A_SalesOrder('1876')": order({ HeaderBillingBlockReason: '02' }),
      A_OutbDeliveryItem: [{ DeliveryDocument: '0080000001' }],
      A_OutbDeliveryHeader: [{ DeliveryDocument: '0080000001', OverallProofOfDeliveryStatus: '' }]
    };
    const out = await call("checkOrderConformance(salesOrder='1876')");
    expect(out.response.findings).toEqual([{
      severity: 'medium', l4: '4.1.4',
      step: 'Remove billing block (VA02)',
      finding: 'Delivered but blocked for billing (header block 02): billing cannot proceed.',
      routeTo: 'blocks'
    }]);
  });

  test('item billing block on a delivery item -> 4.1.4, although the header has none', async () => {
    routes = {
      "A_SalesOrder('1876')": order(),
      A_OutbDeliveryItem: [
        { DeliveryDocument: '0080000001', DeliveryDocumentItem: '000010', ItemBillingBlockReason: '03' },
        { DeliveryDocument: '0080000001', DeliveryDocumentItem: '000020', ItemBillingBlockReason: '' }
      ]
    };
    const out = await call("checkOrderConformance(salesOrder='1876')");
    expect(out.response.findings).toEqual([{
      severity: 'medium', l4: '4.1.4',
      step: 'Remove billing block (VA02)',
      finding: 'Delivered but blocked for billing (item block 03 on delivery 80000001 item 10): billing cannot proceed.',
      routeTo: 'blocks'
    }]);
  });

  test('invoice cancelled -> not billed, 4.1.1 finding', async () => {
    routes = {
      "A_SalesOrder('1876')": order(),
      A_OutbDeliveryItem: [{ DeliveryDocument: '80000001' }],
      A_BillingDocumentItem: [{ BillingDocument: '0090000376' }, { BillingDocument: '0090000377' }],
      'A_BillingDocument?': [
        { BillingDocument: '0090000376', BillingDocumentIsCancelled: true, CancelledBillingDocument: '' },
        { BillingDocument: '0090000377', BillingDocumentIsCancelled: false, CancelledBillingDocument: '0090000376' }
      ]
    };
    const out = await call("checkOrderConformance(salesOrder='1876')");
    expect(out.response.billingDocuments).toEqual([]);
    expect(out.response.findings.map((f) => f.l4)).toEqual(['4.1.1']);
    expect(out.underlyingRequests.find((r) => r.includes('A_BillingDocument?'))).toContain(
      "BillingDocument eq '0090000376' or BillingDocument eq '0090000377'");
  });

  test('billed order -> POD status is not read', async () => {
    routes = {
      "A_SalesOrder('1876')": order(),
      A_OutbDeliveryItem: [{ DeliveryDocument: '80000001' }],
      A_BillingDocumentItem: [{ BillingDocument: '90000376' }]
    };
    const out = await call("checkOrderConformance(salesOrder='1876')");
    expect(out.underlyingRequests.some((r) => r.includes('A_OutbDeliveryHeader'))).toBe(false);
  });

  test('unknown order -> 404 from SAP', async () => {
    routes = { A_SalesOrder: () => Object.assign(new Error('Not found'), { response: { status: 404, data: {} } }) };
    expect(await status("checkOrderConformance(salesOrder='9999')")).toBe(404);
  });
});
