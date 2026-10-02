const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

module.exports = cds.service.impl(async function () {
  this.on('getInvoice', async (req) => {
    const { invoiceNumber } = req.data;
    const response = await executeHttpRequest(
      { destinationName: 'DS4' },
      {
        method: 'GET',
        url: `/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV/A_BillingDocument('${invoiceNumber}')?$expand=to_Item&$format=json`
      }
    );
    return JSON.stringify(response.data.d);
  });
});
