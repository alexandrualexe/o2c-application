const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

// ---- Generic GET/POST helper (no CSRF) ----
async function callDestination(destinationName, method, path, payload, extraHeaders = {}) {
  const response = await executeHttpRequest(
    { destinationName },
    {
      method,
      url: path,
      data: payload,
      headers: { 'sap-client': '100', ...extraHeaders }
    }
  );
  return response;
}

// ---- CSRF token fetch for POST-based OData calls ----
async function getCsrfTokenAndCookies(destinationName, servicePath) {
  const response = await executeHttpRequest(
    { destinationName },
    {
      method: 'GET',
      url: `${servicePath}/`,
      headers: { 'x-csrf-token': 'Fetch', 'sap-client': '100' }
    },
    { fetchCsrfToken: false }
  );
  return {
    csrfToken: response.headers['x-csrf-token'],
    cookies: response.headers['set-cookie']
  };
}

module.exports = function (srv) {

  // ---- getInvoice ----
  srv.on('getInvoice', async (req) => {
    const { invoiceNumber } = req.data;
    const response = await callDestination(
      'DS4',
      'GET',
      `/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV/A_BillingDocument('${invoiceNumber}')?$expand=to_Item&$format=json`
    );
    return JSON.stringify(response.data.d);
  });

  // ---- checkExistingCredits ----
  srv.on('checkExistingCredits', async (req) => {
    const { invoiceNumber } = req.data;

    const returns = await callDestination(
      'DS4',
      'GET',
      `/sap/opu/odata/sap/API_CUSTOMER_RETURN_SRV/A_CustomerReturnItem?$filter=ReferenceSDDocument eq '${invoiceNumber}'&$format=json`
    );

    const credits = await callDestination(
      'DS4',
      'GET',
      `/sap/opu/odata/sap/API_CREDIT_MEMO_REQUEST_SRV/A_CreditMemoRequest?$filter=ReferenceSDDocument eq '${invoiceNumber}'&$format=json`
    );

    return JSON.stringify({
      existingReturns: returns.data.d.results,
      existingCredits: credits.data.d.results
    });
  });

  // ---- createReturn ----
  srv.on('createReturn', async (req) => {
    const { invoiceNumber, invoiceItem, material, quantity, unit, reason, soldToParty } = req.data;

    const { csrfToken, cookies } = await getCsrfTokenAndCookies(
      'DS4',
      '/sap/opu/odata/sap/API_CUSTOMER_RETURN_SRV'
    );

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

    const response = await executeHttpRequest(
      { destinationName: 'DS4' },
      {
        method: 'POST',
        url: '/sap/opu/odata/sap/API_CUSTOMER_RETURN_SRV/A_CustomerReturn',
        data: payload,
        headers: {
          'x-csrf-token': csrfToken,
          'Cookie': cookies ? cookies.join('; ') : '',
          'Content-Type': 'application/json',
          'sap-client': '100'
        }
      }
    );

    return JSON.stringify(response.data.d);
  });

  // ---- createCreditMemoRequest ----
  srv.on('createCreditMemoRequest', async (req) => {
    const { invoiceNumber, material, quantity, unit, reason, soldToParty } = req.data;

    const { csrfToken, cookies } = await getCsrfTokenAndCookies(
      'DS4',
      '/sap/opu/odata/sap/API_CREDIT_MEMO_REQUEST_SRV'
    );

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

    const response = await executeHttpRequest(
      { destinationName: 'DS4' },
      {
        method: 'POST',
        url: '/sap/opu/odata/sap/API_CREDIT_MEMO_REQUEST_SRV/A_CreditMemoRequest',
        data: payload,
        headers: {
          'x-csrf-token': csrfToken,
          'Cookie': cookies ? cookies.join('; ') : '',
          'Content-Type': 'application/json',
          'sap-client': '100'
        }
      }
    );

    return JSON.stringify(response.data.d);
  });

};