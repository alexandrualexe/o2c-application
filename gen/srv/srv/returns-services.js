const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const DEST = 'DS4';
const SAP_CLIENT = '100';

const ACTIONS = ['RETURN', 'CREDIT', 'REPLACEMENT', 'REJECT'];
const STATUSES = ['APPROVED', 'REJECTED'];

// ---- Generic request helper ----
async function callDestination(method, path, payload, extraHeaders = {}) {
  return executeHttpRequest(
    { destinationName: DEST },
    {
      method,
      url: path,
      data: payload,
      headers: { 'sap-client': SAP_CLIENT, ...extraHeaders }
    }
  );
}

// ---- CSRF token + cookies for POST calls ----
async function getCsrfTokenAndCookies(servicePath) {
  const response = await executeHttpRequest(
    { destinationName: DEST },
    {
      method: 'GET',
      url: `${servicePath}/`,
      headers: { 'x-csrf-token': 'Fetch', 'sap-client': SAP_CLIENT }
    },
    { fetchCsrfToken: false }
  );

  const setCookie = response.headers['set-cookie'];

  return {
    csrfToken: response.headers['x-csrf-token'],
    cookies: Array.isArray(setCookie)
      ? setCookie.map((cookie) => cookie.split(';')[0]).join('; ')
      : ''
  };
}

// ---- Convert backend errors into CAP errors ----
function handleError(req, err, context) {
  const status = err.response?.status;
  const backendMsg =
    err.response?.data?.error?.message?.value ||
    err.response?.data?.error?.message ||
    err.message;

  console.error(`${context} failed:`, status, backendMsg);
  return req.reject(status || 500, `${context} failed: ${backendMsg}`);
}

// ---- SAP OData v2 returns { d: ... } ----
const unwrap = (data) => (data && data.d !== undefined ? data.d : data);

module.exports = function (srv) {
  // Requires "entity AuditLog as projection on o2c.ReturnAuditLog"
  // in the ReturnsService CDS definition.
  const { AuditLog } = srv.entities;

  // ---- logRequest: create a pending audit entry ----
  srv.on('logRequest', async (req) => {
    const { invoiceNumber, proposedAction } = req.data;

    if (
      typeof invoiceNumber !== 'string' ||
      !/^[A-Za-z0-9]{1,10}$/.test(invoiceNumber)
    ) {
      return req.reject(400, 'invoiceNumber must be 1–10 letters or digits');
    }

    if (!ACTIONS.includes(proposedAction)) {
      return req.reject(
        400,
        `proposedAction must be one of: ${ACTIONS.join(', ')}`
      );
    }

    const ID = cds.utils.uuid();
    const tx = cds.tx(req);

    await tx.run(
      INSERT.into(AuditLog).entries({
        ID,
        invoiceNumber,
        proposedAction,
        approvalStatus: 'PENDING'
      })
    );

    return tx.run(SELECT.one.from(AuditLog).where({ ID }));
  });

  // ---- setApprovalStatus: decide a pending request ----
  srv.on('setApprovalStatus', async (req) => {
    const { ID, status } = req.data;

    if (!ID) {
      return req.reject(400, 'ID is required');
    }

    if (!STATUSES.includes(status)) {
      return req.reject(
        400,
        `status must be one of: ${STATUSES.join(', ')}`
      );
    }

    const tx = cds.tx(req);

    // Include PENDING in the update condition so concurrent approvals
    // cannot both change the same request.
    const updated = await tx.run(
      UPDATE(AuditLog)
        .set({
          approvalStatus: status,
          decidedAt: new Date()
        })
        .where({ ID, approvalStatus: 'PENDING' })
    );

    if (!updated) {
      const existing = await tx.run(
        SELECT.one.from(AuditLog).where({ ID })
      );

      if (!existing) {
        return req.reject(404, `Request ${ID} not found`);
      }

      return req.reject(
        409,
        `Request ${ID} is already ${existing.approvalStatus}`
      );
    }

    return tx.run(SELECT.one.from(AuditLog).where({ ID }));
  });

  // ---- getInvoice ----
  srv.on('getInvoice', async (req) => {
    const { invoiceNumber } = req.data;

    try {
      const response = await callDestination(
        'GET',
        `/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV/A_BillingDocument('${invoiceNumber}')?$expand=to_Item&$format=json`
      );

      return JSON.stringify(unwrap(response.data));
    } catch (err) {
      return handleError(req, err, 'getInvoice');
    }
  });

  // ---- checkExistingCredits ----
  srv.on('checkExistingCredits', async (req) => {
    const { invoiceNumber } = req.data;

    try {
      const [returns, credits] = await Promise.all([
        callDestination(
          'GET',
          `/sap/opu/odata/sap/API_CUSTOMER_RETURN_SRV/A_CustomerReturnItem?$filter=ReferenceSDDocument eq '${invoiceNumber}'&$format=json`
        ),
        callDestination(
          'GET',
          `/sap/opu/odata/sap/API_CREDIT_MEMO_REQUEST_SRV/A_CreditMemoRequest?$filter=ReferenceSDDocument eq '${invoiceNumber}'&$format=json`
        )
      ]);

      return JSON.stringify({
        existingReturns: unwrap(returns.data).results || [],
        existingCredits: unwrap(credits.data).results || []
      });
    } catch (err) {
      return handleError(req, err, 'checkExistingCredits');
    }
  });

  // ---- createReturn ----
  srv.on('createReturn', async (req) => {
    const {
      invoiceNumber,
      invoiceItem,
      material,
      quantity,
      unit,
      reason,
      soldToParty
    } = req.data;

    const servicePath = '/sap/opu/odata/sap/API_CUSTOMER_RETURN_SRV';

    try {
      const { csrfToken, cookies } =
        await getCsrfTokenAndCookies(servicePath);

      const payload = {
        CustomerReturnType: 'YRE',
        SalesOrganization: 'YSOD',
        DistributionChannel: 'Y1',
        OrganizationDivision: 'Y5',
        SoldToParty: soldToParty,
        SDDocumentReason: reason,
        PurchaseOrderByCustomer: `COMPLAINT-${invoiceNumber}`,
        to_Item: [{
          Material: material,
          RequestedQuantity: quantity,
          RequestedQuantityUnit: unit,
          ReferenceSDDocument: invoiceNumber,
          ReferenceSDDocumentItem: invoiceItem
        }]
      };

      const response = await callDestination(
        'POST',
        `${servicePath}/A_CustomerReturn`,
        payload,
        {
          'x-csrf-token': csrfToken,
          'Cookie': cookies,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      );

      return JSON.stringify(unwrap(response.data));
    } catch (err) {
      return handleError(req, err, 'createReturn');
    }
  });

  // ---- createCreditMemoRequest ----
  srv.on('createCreditMemoRequest', async (req) => {
    const {
      invoiceNumber,
      material,
      quantity,
      unit,
      reason,
      soldToParty
    } = req.data;

    const servicePath =
      '/sap/opu/odata/sap/API_CREDIT_MEMO_REQUEST_SRV';

    try {
      const { csrfToken, cookies } =
        await getCsrfTokenAndCookies(servicePath);

      const payload = {
        SalesDocumentType: 'YCR',
        SalesOrganization: 'YSOD',
        DistributionChannel: 'Y1',
        OrganizationDivision: 'Y5',
        SoldToParty: soldToParty,
        SDDocumentReason: reason,
        PurchaseOrderByCustomer: `COMPLAINT-${invoiceNumber}`,
        to_Item: [{
          Material: material,
          RequestedQuantity: quantity,
          RequestedQuantityUnit: unit,
          ReferenceSDDocument: invoiceNumber
        }]
      };

      const response = await callDestination(
        'POST',
        `${servicePath}/A_CreditMemoRequest`,
        payload,
        {
          'x-csrf-token': csrfToken,
          'Cookie': cookies,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      );

      return JSON.stringify(unwrap(response.data));
    } catch (err) {
      return handleError(req, err, 'createCreditMemoRequest');
    }
  });
  // ---- findInvoices: customer's invoices containing a material in a date range ----
  srv.on('findInvoices', async (req) => {
    const { soldToParty, material, fromDate, toDate } = req.data;
    const idOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
    const dateOk = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

    if (!idOk(soldToParty) || !idOk(material) || !dateOk(fromDate) || !dateOk(toDate)) {
      return req.reject(400, 'soldToParty, material (ids) and fromDate, toDate (YYYY-MM-DD) are required');
    }
    try {
      const filter =
        `SoldToParty eq '${soldToParty}' and ` +
        `BillingDocumentDate ge datetime'${fromDate}T00:00:00' and ` +
        `BillingDocumentDate le datetime'${toDate}T00:00:00'`;
      const response = await callDestination(
        'GET',
        `/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV/A_BillingDocument?$filter=${encodeURIComponent(filter)}&$expand=to_Item&$format=json`
      );
      const invoices = (unwrap(response.data).results || [])
        .map((doc) => ({
          ...doc,
          to_Item: { results: (doc.to_Item?.results || []).filter((i) => i.Material === material) }
        }))
        .filter((doc) => doc.to_Item.results.length > 0);
      return JSON.stringify({ soldToParty, material, fromDate, toDate, invoices });
    } catch (err) {
      return handleError(req, err, 'findInvoices');
    }
  });

  // ---- getAgreedPrice: fetch the current PR00 condition price ----
  srv.on('getAgreedPrice', async (req) => {
    const { soldToParty, material, salesOrganization, distributionChannel } = req.data;
    const idOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);

    if (!idOk(soldToParty) || !idOk(material) || !idOk(salesOrganization) || !idOk(distributionChannel)) {
      return req.reject(400, 'soldToParty, material, salesOrganization, and distributionChannel (all IDs) are required');
    }

    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const filter =
        `SoldToParty eq '${soldToParty}' and ` +
        `Material eq '${material}' and ` +
        `SalesOrganization eq '${salesOrganization}' and ` +
        `DistributionChannel eq '${distributionChannel}' and ` +
        `ConditionType eq 'PR00' and ` +
        `ConditionValidityStartDate le datetime'${today}T00:00:00' and ` +
        `ConditionValidityEndDate ge datetime'${today}T00:00:00'`;

      const response = await callDestination(
        'GET',
        `/sap/opu/odata/sap/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgCndnRecdValidity?$filter=${encodeURIComponent(filter)}&$expand=to_SlsPrcgConditionRecord&$format=json`
      );

      const records = unwrap(response.data).results || [];
      return JSON.stringify({
        soldToParty,
        material,
        salesOrganization,
        distributionChannel,
        today,
        agreedPrices: records.map((r) => ({
          ConditionRecord: r.ConditionRecord,
          ConditionType: r.ConditionType,
          ConditionRateValue: r.to_SlsPrcgConditionRecord?.ConditionRateValue,
          ConditionValidityStartDate: r.ConditionValidityStartDate,
          ConditionValidityEndDate: r.ConditionValidityEndDate
        }))
      });
    } catch (err) {
      return handleError(req, err, 'getAgreedPrice');
    }
  });

  // ---- getReturnStatus: check warehouse receipt status ----
  srv.on('getReturnStatus', async (req) => {
    const { returnDocumentNumber } = req.data;
    if (!returnDocumentNumber) {
      return req.reject(400, 'returnDocumentNumber is required');
    }
    try {
      const response = await callDestination(
        'GET',
        `/sap/opu/odata/sap/API_CUSTOMER_RETURN_SRV/A_CustomerReturn('${returnDocumentNumber}')?$format=json`
      );
      const returnData = unwrap(response.data);
      return JSON.stringify({
        returnDocumentNumber,
        overallProcessingStatus: returnData.OverallProcessingStatus,
        warehouseReceiptStatus: returnData.WarehouseReceiptStatus || 'UNKNOWN',
        received: returnData.WarehouseReceiptStatus === 'C'
      });
    } catch (err) {
      return handleError(req, err, 'getReturnStatus');
    }
  });

  // ---- releaseCreditMemoRequest: remove billing block and send version stamp ----
  srv.on('releaseCreditMemoRequest', async (req) => {
    const { creditMemoNumber, versionStamp } = req.data;
    if (!creditMemoNumber || !versionStamp) {
      return req.reject(400, 'creditMemoNumber and versionStamp are required');
    }
    const servicePath = '/sap/opu/odata/sap/API_CREDIT_MEMO_REQUEST_SRV';
    try {
      const { csrfToken, cookies } =
        await getCsrfTokenAndCookies(servicePath);
      const payload = {
        BillingBlockingReason: ''
      };
      const response = await callDestination(
        'PATCH',
        `${servicePath}/A_CreditMemoRequest('${creditMemoNumber}')`,
        payload,
        {
          'x-csrf-token': csrfToken,
          'Cookie': cookies,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'If-Match': versionStamp
        }
      );
      return JSON.stringify({
        creditMemoNumber,
        status: 'RELEASED',
        updateResult: unwrap(response.data)
      });
    } catch (err) {
      return handleError(req, err, 'releaseCreditMemoRequest');
    }
  });
};