// Boots the CAP service in memory (SQLite) with all SAP calls mocked; nothing leaves this process.
jest.mock('@sap-cloud-sdk/http-client', () => ({ executeHttpRequest: jest.fn() }));

const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const { POST, GET } = cds.test(__dirname + '/..');

// ---- Fake SAP backend ----
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
    calls: []
  };
}

const notFound = () => Object.assign(new Error('Not found'), { response: { status: 404, data: {} } });

executeHttpRequest.mockImplementation(async (dest, { method, url, data, headers }) => {
  sap.calls.push({ method, url, data, headers });
  const ok = (d) => ({ data: { d }, headers: {} });

  if (method === 'GET' && url.endsWith('/')) return { data: {}, headers: { 'x-csrf-token': 'token' } };

  if (method === 'GET' && url.includes('A_BillingDocument(')) {
    const id = url.match(/A_BillingDocument\('(\w+)'\)/)[1];
    if (!sap.invoices[id]) throw notFound();
    return ok(sap.invoices[id]);
  }
  if (method === 'GET' && url.includes('A_CustomerReturnItem?')) return ok({ results: sap.existingReturns });
  if (method === 'GET' && url.includes('A_CreditMemoRequest?')) return ok({ results: sap.existingCredits });
  if (method === 'GET' && url.includes('A_SlsPrcgCndnRecdValidity')) return ok({ results: [] });

  if (method === 'GET' && url.includes('A_CustomerReturn(')) {
    return ok({ CustomerReturn: '60000001', OverallSDProcessStatus: 'B', GoodsMovementStatus: 'C', __metadata: { etag: 'W/"ret-v2"' } });
  }
  if (method === 'GET' && url.includes('A_CreditMemoRequest(')) {
    return ok({ CreditMemoRequest: '70000001', __metadata: { etag: 'W/"cr-v2"' } });
  }
  if (method === 'POST' && url.endsWith('/A_CustomerReturn')) {
    return ok({
      CustomerReturn: '60000001', CustomerReturnType: 'YRE', SoldToParty: data.SoldToParty,
      TotalNetAmount: '20.00', TransactionCurrency: 'EUR', __metadata: { etag: 'W/"ret-v1"' }
    });
  }
  if (method === 'POST' && url.endsWith('/A_CreditMemoRequest')) {
    return ok({ CreditMemoRequest: '70000001', CreditMemoRequestType: 'YCR', __metadata: { etag: 'W/"cr-v1"' } });
  }
  if (method === 'PATCH') return { data: '', headers: {} };

  throw new Error(`Unmocked SAP call: ${method} ${url}`);
});

let srv, AuditLog;
beforeAll(async () => {
  srv = await cds.connect.to('ReturnsService');
  ({ AuditLog } = srv.entities);
});

beforeEach(async () => {
  resetSap();
  await DELETE.from(AuditLog);
});

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

  test('getReturnStatus returns processing and goods movement status', async () => {
    const { data } = await GET(`/odata/v4/returns/getReturnStatus(returnDocumentNumber='60000001')`);
    expect(data).toMatchObject({ overallProcessingStatus: 'B', goodsMovementStatus: 'C', received: true });
  });
});

// ---------------------------------------------------------------------------
describe('6. invoiceNumber is validated before it goes into OData URLs', () => {
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
