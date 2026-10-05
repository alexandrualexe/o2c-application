const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const DEST = 'DS4';
const SAP_CLIENT = '100';

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
    // Send back only name=value part of each cookie
    cookies: Array.isArray(setCookie)
      ? setCookie.map((c) => c.split(';')[0]).join('; ')
      : ''
  };
}

// ---- Convert backend errors into proper CAP errors ----
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

  // ---- getInvoice ----
  srv.on('getInvoice', async (req) => {
    const { invoiceNumber } = req.data;
    try {
      const response = await callDestination(
        'GET',
        `/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV/A_BillingDocument('${invoiceNumber}')?$expand=to_Item&$format=json`
      );
      return unwrap(response.data);
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

      return {
        existingReturns: unwrap(returns.data).results || [],
        existingCredits: unwrap(credits.data).results || []
      };
    } catch (err) {
      return handleError(req, err, 'checkExistingCredits');
    }
  });

  // ---- createReturn ----
  srv.on('createReturn', async (req) => {
    const { invoiceNumber, invoiceItem, material, quantity, unit, reason, soldToParty } = req.data;
    const servicePath = '/sap/opu/odata/sap/API_CUSTOMER_RETURN_SRV';

    try {
      const { csrfToken, cookies } = await getCsrfTokenAndCookies(servicePath);

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

      return unwrap(response.data);
    } catch (err) {
      return handleError(req, err, 'createReturn');
    }
  });

  // ---- createCreditMemoRequest ----
  srv.on('createCreditMemoRequest', async (req) => {
    const { invoiceNumber, material, quantity, unit, reason, soldToParty } = req.data;
    const servicePath = '/sap/opu/odata/sap/API_CREDIT_MEMO_REQUEST_SRV';

    try {
      const { csrfToken, cookies } = await getCsrfTokenAndCookies(servicePath);

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

      return unwrap(response.data);
    } catch (err) {
      return handleError(req, err, 'createCreditMemoRequest');
    }
  });

};