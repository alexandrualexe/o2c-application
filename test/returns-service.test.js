// =============================================================================
// Tests for ReturnsService (srv/returns-services.js)
// -----------------------------------------------------------------------------
// Boots the CAP service in memory (SQLite) with all SAP calls mocked; nothing leaves this process.
//
// Run with:  npm test
// (the script passes --experimental-vm-modules, which CAP 10 needs under Jest)
//
// How it works:
//   - jest.mock replaces the SAP Cloud SDK's executeHttpRequest with a fake
//     SAP backend (see the mockImplementation below), so no destination,
//     network or DS4 system is needed.
//   - cds.test() starts the real service; tests call it either in-process
//     (srv.send) or over HTTP (POST/GET) when the OData layer matters.
//   - Each describe block covers one of the fixes on this branch.
// =============================================================================

// Must come before anything requires the SDK, so the service gets the mock
jest.mock('@sap-cloud-sdk/http-client', () => ({ executeHttpRequest: jest.fn() }));

const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

// Start the whole project (db + srv) for this test file; POST/GET are HTTP helpers
const { POST, GET } = cds.test(__dirname + '/..');

// ---- Fake SAP backend ----
// "sap" holds the state of the fake system. Tests change it (e.g. add an
// existing return) to steer the scenario; every request is recorded in
// sap.calls so tests can assert what was (or was not) sent to SAP.
let sap;
function resetSap() {
  sap = {
    invoices: {
      '90000123': {
        BillingDocument: '90000123',
        SoldToParty: '100001',
        SalesOrganization: 'YSOD',
        DistributionChannel: 'Y1',
        to_Item: {
          results: [{
            BillingDocumentItem: '10', Material: 'TG11',
            BillingQuantity: '10', BillingQuantityUnit: 'PC', NetAmount: '100.00'
          }]
        }
      }
    },
    existingReturns: [],
    existingCredits: [],
    returnsDeliveryItems: [
      { ref: '60000001', DeliveryDocument: '0084000000', GoodsMovementStatus: 'C' },
      { ref: '60000001', DeliveryDocument: '0084000000', GoodsMovementStatus: 'C' }
    ],
    calls: []
  };
}

// Error shaped like an HTTP 404 from the SAP Cloud SDK
const notFound = () => Object.assign(new Error('Not found'), { response: { status: 404, data: {} } });

// Routes each request by HTTP method and URL, like the real OData APIs would
executeHttpRequest.mockImplementation(async (dest, { method, url, data, headers }) => {
  sap.calls.push({ method, url, data, headers });
  // OData v2 response envelope: { d: ... }
  const ok = (d) => ({ data: { d }, headers: {} });

  // CSRF token fetch (GET on the service root)

  if (method === 'GET' && url.endsWith('/')) return { data: {}, headers: { 'x-csrf-token': 'token' } };

  // Single invoice
  if (method === 'GET' && url.includes('A_BillingDocument(')) {
    const id = url.match(/A_BillingDocument\('(\w+)'\)/)[1];
    if (!sap.invoices[id]) throw notFound();
    return ok(sap.invoices[id]);
  }
  // Duplicate check (checkExistingCredits) and agreed price lookup
  if (method === 'GET' && url.includes('A_CustomerReturnItem?')) return ok({ results: sap.existingReturns });
  if (method === 'GET' && url.includes('A_CreditMemoRequest?')) return ok({ results: sap.existingCredits });
  if (method === 'GET' && url.includes('A_SlsPrcgCndnRecdValidity')) return ok({ results: [] });

  // Single documents, read for the current ETag (__metadata.etag) and the status.
  // The ETags differ from the ones returned on create ("v2" vs "v1"), so tests
  // can tell whether the release used a freshly read ETag.
  if (method === 'GET' && url.includes('A_CustomerReturn(')) {
    return ok({ CustomerReturn: '60000001', OverallSDProcessStatus: 'B', __metadata: { etag: 'W/"ret-v2"' } });
  }
  // Returns delivery items (goods receipt of a return)
  if (method === 'GET' && url.includes('A_ReturnsDeliveryItem?')) {
    const ref = decodeURIComponent(url).match(/ReferenceSDDocument eq '(\w+)'/)[1];
    return ok({ results: sap.returnsDeliveryItems.filter((i) => i.ref === ref) });
  }
  if (method === 'GET' && url.includes('A_CreditMemoRequest(')) {
    return ok({ CreditMemoRequest: '70000001', __metadata: { etag: 'W/"cr-v2"' } });
  }
  // Document creation
  if (method === 'POST' && url.endsWith('/A_CustomerReturn')) {
    return ok({
      CustomerReturn: '60000001', CustomerReturnType: 'YRE', SoldToParty: data.SoldToParty,
      TotalNetAmount: '20.00', TransactionCurrency: 'EUR', __metadata: { etag: 'W/"ret-v1"' }
    });
  }
  if (method === 'POST' && url.endsWith('/A_CreditMemoRequest')) {
    return ok({ CreditMemoRequest: '70000001', CreditMemoRequestType: 'YCR', __metadata: { etag: 'W/"cr-v1"' } });
  }
  // Release (removing the billing block)
  if (method === 'PATCH') return { data: '', headers: {} };

  // Fail loudly on anything unexpected, so a new SAP call can't go unnoticed
  throw new Error(`Unmocked SAP call: ${method} ${url}`);
});

// The service instance and its AuditLog entity, available once cds.test has booted
let srv, AuditLog;
beforeAll(async () => {
  srv = await cds.connect.to('ReturnsService');
  ({ AuditLog } = srv.entities);
});

// Every test starts with a clean fake SAP and an empty audit log
beforeEach(async () => {
  resetSap();
  await DELETE.from(AuditLog);
});

// Shortcuts with valid defaults; each test overrides only what it is about
const propose = (data) => srv.send('proposeAction', {
  invoiceNumber: '90000123', invoiceItem: '10', material: 'TG11', quantity: 2,
  claimedAmount: 0, reason: '', soldToParty: '100001', ...data
});

// Inserts an audit entry directly, in the given state
async function auditEntry(data) {
  const ID = cds.utils.uuid();
  await INSERT.into(AuditLog).entries({
    ID, invoiceNumber: '90000123', invoiceItem: '10', material: 'TG11',
    approvalStatus: 'APPROVED', requiredApprover: 'credit-manager', ...data
  });
  return ID;
}

const createReturn = (data) => srv.send('createReturn', {
  invoiceNumber: '90000123', invoiceItem: '10', material: 'TG11',
  quantity: '2', unit: 'PC', rule: 'R2', soldToParty: '100001', ...data
});

const createCredit = (data) => srv.send('createCreditMemoRequest', {
  invoiceNumber: '90000123', invoiceItem: '10', material: 'TG11', quantity: '2', unit: 'PC',
  rule: 'R5', soldToParty: '100001', evidenceUrl: 'https://proof', ...data
});

// ---------------------------------------------------------------------------
// Fix 1: the ETag is read from __metadata.etag, stored, and refreshed on release
describe('1. ETag handling', () => {
  test('createReturn stores and returns the OData v2 ETag', async () => {
    const auditLogID = await auditEntry({ rule: 'R2', proposedAction: 'RETURN' });
    const res = await createReturn({ auditLogID });
    expect(res.sapDocumentVersion).toBe('W/"ret-v1"');
    expect((await SELECT.one.from(AuditLog).where({ ID: auditLogID })).sapDocumentVersion).toBe('W/"ret-v1"');
  });

  test('createCreditMemoRequest stores and returns the OData v2 ETag', async () => {
    const auditLogID = await auditEntry({ rule: 'R5', proposedAction: 'CREDIT' });
    const res = await createCredit({ auditLogID });
    expect(res.sapDocumentVersion).toBe('W/"cr-v1"');
    expect((await SELECT.one.from(AuditLog).where({ ID: auditLogID })).sapDocumentVersion).toBe('W/"cr-v1"');
  });

  test('releaseCustomerReturn fetches the current ETag when none is given', async () => {
    expect((await srv.send('releaseCustomerReturn', { returnDocumentNumber: '60000001' })).status).toBe('RELEASED');
    expect(sap.calls.find((c) => c.method === 'PATCH').headers['If-Match']).toBe('W/"ret-v2"');
  });

  test('releaseCreditMemoRequest fetches the current ETag when none is given', async () => {
    await srv.send('releaseCreditMemoRequest', { creditMemoNumber: '70000001' });
    expect(sap.calls.find((c) => c.method === 'PATCH').headers['If-Match']).toBe('W/"cr-v2"');
  });

  test('a given versionStamp is used as is', async () => {
    await srv.send('releaseCustomerReturn', { returnDocumentNumber: '60000001', versionStamp: 'W/"mine"' });
    expect(sap.calls.find((c) => c.method === 'PATCH').headers['If-Match']).toBe('W/"mine"');
  });
});

// ---------------------------------------------------------------------------
// Fix 2: an approval can only create the document it was given for
describe('2. Document creation must match the approved entry', () => {
  test('an approval cannot be reused for another invoice', async () => {
    const auditLogID = await auditEntry({ rule: 'R5', proposedAction: 'CREDIT' });
    await expect(createCredit({ auditLogID, invoiceNumber: '90000999' })).rejects.toMatchObject({ code: 400 });
    expect(sap.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('an approval cannot be reused for another rule', async () => {
    const auditLogID = await auditEntry({ rule: 'R1', proposedAction: 'RETURN' });
    await expect(createReturn({ auditLogID, rule: 'R2' })).rejects.toMatchObject({ code: 400 });
  });

  test('an approved R4 rejection (no overcharge) cannot create a credit memo', async () => {
    const auditLogID = await auditEntry({ rule: 'R4', proposedAction: 'REJECT', agreementApproved: true });
    await expect(createCredit({ auditLogID, rule: 'R4' })).rejects.toMatchObject({ code: 400 });
    expect(sap.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('a PENDING proposal cannot create a document', async () => {
    const auditLogID = await auditEntry({ rule: 'R5', proposedAction: 'PENDING' });
    await expect(createCredit({ auditLogID })).rejects.toMatchObject({ code: 400 });
  });
});

// ---------------------------------------------------------------------------
// Fix 3: the SAP duplicate re-check blocks approving, never rejecting
describe('3. setApprovalStatus duplicate check', () => {
  const decide = (ID, status) =>
    srv.send('setApprovalStatus', { ID, status, approvedBy: 'u1', approverRole: 'credit-manager' });

  test('rejecting is allowed even when SAP already has a document', async () => {
    const ID = await auditEntry({ approvalStatus: 'PENDING', rule: 'R1', proposedAction: 'RETURN' });
    sap.existingReturns = [{ CustomerReturn: '60000009' }];
    expect((await decide(ID, 'REJECTED')).approvalStatus).toBe('REJECTED');
  });

  test('approving is blocked when SAP already has a document', async () => {
    const ID = await auditEntry({ approvalStatus: 'PENDING', rule: 'R1', proposedAction: 'RETURN' });
    sap.existingReturns = [{ CustomerReturn: '60000009' }];
    await expect(decide(ID, 'APPROVED')).rejects.toMatchObject({ code: 409 });
    expect((await SELECT.one.from(AuditLog).where({ ID })).approvalStatus).toBe('PENDING');
  });
});

// ---------------------------------------------------------------------------
// Extra fix: these SAP lookups used to go to the database service and never ran
describe('SAP check fix (srv.send instead of the DB transaction)', () => {
  test('proposeAction returns R8 when SAP already has a return for the invoice', async () => {
    sap.existingReturns = [{ CustomerReturn: '60000009' }];
    const res = await propose({ reason: 'defective' });
    expect(res).toMatchObject({ rule: 'R8', proposedAction: 'REJECT' });
  });

  test('R4 looks up the agreed price in SAP', async () => {
    await propose({ reason: 'wrong price' });
    expect(sap.calls.some((c) => c.url.includes('A_SlsPrcgCndnRecdValidity'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 5: tested over HTTP, because fields missing from the CDS result types
// are silently dropped by the OData layer (in-process calls would not show it)
describe('5. Result fields reach the OData client', () => {
  test('createReturn returns CustomerReturnType, TotalNetAmount and TransactionCurrency', async () => {
    const auditLogID = await auditEntry({ rule: 'R2', proposedAction: 'RETURN' });
    const { data } = await POST('/odata/v4/returns/createReturn', {
      auditLogID, invoiceNumber: '90000123', invoiceItem: '10', material: 'TG11',
      quantity: '2', unit: 'PC', rule: 'R2', soldToParty: '100001'
    });
    expect(data).toMatchObject({
      CustomerReturn: '60000001', CustomerReturnType: 'YRE',
      TotalNetAmount: '20.00', TransactionCurrency: 'EUR', sapDocumentVersion: 'W/"ret-v1"'
    });
  });

  test('createCreditMemoRequest returns the credit memo type', async () => {
    const auditLogID = await auditEntry({ rule: 'R5', proposedAction: 'CREDIT' });
    const { data } = await POST('/odata/v4/returns/createCreditMemoRequest', {
      auditLogID, invoiceNumber: '90000123', invoiceItem: '10', material: 'TG11', quantity: '2', unit: 'PC',
      rule: 'R5', soldToParty: '100001', evidenceUrl: 'https://proof'
    });
    expect(data).toMatchObject({ CreditMemoRequest: '70000001', SalesDocumentType: 'YCR' });
  });

  test('getReturnStatus reads the goods receipt from the returns delivery items', async () => {
    const { data } = await GET(`/odata/v4/returns/getReturnStatus(returnDocumentNumber='60000001')`);
    expect(data).toMatchObject({
      overallProcessingStatus: 'B', returnsDelivery: '84000000', goodsMovementStatus: 'C', received: true
    });
    expect(decodeURIComponent(sap.calls.find((c) => c.url.includes('A_ReturnsDeliveryItem')).url))
      .toContain("API_CUSTOMER_RETURNS_DELIVERY_SRV;v=0002/A_ReturnsDeliveryItem?$filter=ReferenceSDDocument eq '60000001'");
  });

  test('getReturnStatus: one item not yet received -> B, not received', async () => {
    sap.returnsDeliveryItems[1].GoodsMovementStatus = 'A';
    const { data } = await GET(`/odata/v4/returns/getReturnStatus(returnDocumentNumber='60000001')`);
    expect(data).toMatchObject({ goodsMovementStatus: 'B', received: false });
  });

  test('getReturnStatus: no returns delivery yet -> NO_DELIVERY; padded reference tried too', async () => {
    sap.returnsDeliveryItems = [];
    const { data } = await GET(`/odata/v4/returns/getReturnStatus(returnDocumentNumber='60000001')`);
    expect(data).toMatchObject({ returnsDelivery: '', goodsMovementStatus: 'NO_DELIVERY', received: false });
    expect(sap.calls.filter((c) => c.url.includes('A_ReturnsDeliveryItem'))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Fix 6: input validation before values are put into SAP OData URLs
describe('6. invoiceNumber is validated before it goes into OData URLs', () => {
  // Would turn the SAP query into "... eq '1') or ('1'" if it got through
  const bad = "1') or ('1";

  test.each(['proposeAction', 'getInvoice', 'checkExistingCredits'])('%s rejects bad input with 400', async (action) => {
    const data = action === 'proposeAction'
      ? { invoiceNumber: bad, invoiceItem: '10', material: 'TG11', quantity: 1, claimedAmount: 0, reason: '', soldToParty: '' }
      : { invoiceNumber: bad };
    await expect(srv.send(action, data)).rejects.toMatchObject({ code: 400 });
    expect(sap.calls).toHaveLength(0);
  });

  test('valid invoice numbers still work', async () => {
    expect((await propose({ reason: 'defective' })).rule).toBe('R2');
  });
});

// ---------------------------------------------------------------------------
// Approval tiers: R3/R4/R5 need at least a credit manager, and above 5000 EUR
// the finance director, like any other credit
describe('Approval tiers for credit-only rules', () => {
  // Line becomes 10 PC for 60000.00, so 2 PC = 12000 EUR
  const bigLine = () => { sap.invoices['90000123'].to_Item.results[0].NetAmount = '60000.00'; };

  test.each([
    ['ruined', 'R3'],
    ['short delivery', 'R5']
  ])('%s above 5000 EUR -> finance director', async (reason, rule) => {
    bigLine();
    expect(await propose({ reason })).toMatchObject({ rule, creditValue: 12000, requiredApprover: 'finance-director' });
  });

  test('small R3/R5 credits still need a credit manager', async () => {
    expect(await propose({ reason: 'ruined' })).toMatchObject({ rule: 'R3', creditValue: 20, requiredApprover: 'credit-manager' });
    expect(await propose({ reason: 'short delivery' })).toMatchObject({ rule: 'R5', requiredApprover: 'credit-manager' });
  });

  test('logRequest uses the same tiers', async () => {
    const entry = await srv.send('logRequest', {
      invoiceNumber: '90000123', proposedAction: 'CREDIT', rule: 'R3', reason: 'ruined',
      claimedQuantity: 2, claimedAmount: 0, creditValue: 12000, evidenceUrl: 'https://photo'
    });
    expect(entry.requiredApprover).toBe('finance-director');
  });

  test('a credit manager cannot approve a large R3 credit', async () => {
    const entry = await srv.send('logRequest', {
      invoiceNumber: '90000123', proposedAction: 'CREDIT', rule: 'R3', reason: 'ruined',
      claimedQuantity: 2, claimedAmount: 0, creditValue: 12000, evidenceUrl: 'https://photo'
    });
    await expect(srv.send('setApprovalStatus', {
      ID: entry.ID, status: 'APPROVED', approvedBy: 'u1', approverRole: 'credit-manager'
    })).rejects.toMatchObject({ code: 403 });
  });
});

// ---------------------------------------------------------------------------
// R4: the agreed price is looked up for the invoice's customer, so it also
// works when the complaint did not name the customer
describe('R4 price lookup without soldToParty', () => {
  test('uses the sold-to party from the invoice', async () => {
    await propose({ reason: 'wrong price', soldToParty: '' });
    const lookup = sap.calls.find((c) => c.url.includes('A_SlsPrcgCndnRecdValidity'));
    expect(lookup).toBeDefined();
    expect(decodeURIComponent(lookup.url)).toContain("SoldToParty eq '100001'");
  });
});
