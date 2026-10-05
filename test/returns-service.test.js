// Boots the CAP service in memory (SQLite) with all SAP calls mocked; nothing leaves this process.
jest.mock('@sap-cloud-sdk/http-client', () => ({ executeHttpRequest: jest.fn() }));
process.env.EMAIL_MAX_ATTEMPTS = '3';

const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const { POST } = cds.test(__dirname + '/..');

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
            BillingDocumentItem: '000010', Material: 'TG11',
            BillingQuantity: '10', BillingQuantityUnit: 'PC', NetAmount: '100.00'
          }]
        }
      }
    },
    existingReturns: [],
    existingCredits: [],
    agreedPrices: [],
    down: false,        // whole SAP system unreachable
    creditsDown: false, // only the return/credit memo APIs failing
    calls: []
  };
}

const notFound = () => Object.assign(new Error('Not found'), { response: { status: 404, data: {} } });

executeHttpRequest.mockImplementation(async (dest, { method, url, data, headers }) => {
  sap.calls.push({ method, url, data, headers });
  if (sap.down) throw new Error('Failed to load destination.');
  if (sap.creditsDown && url.includes('?$filter=ReferenceSDDocument')) {
    throw Object.assign(new Error('Service unavailable'), { response: { status: 503, data: {} } });
  }
  const ok = (d, extraHeaders = {}) => ({ data: { d }, headers: extraHeaders });

  if (method === 'GET' && url.endsWith('/')) return { data: {}, headers: { 'x-csrf-token': 'token' } };

  if (method === 'GET' && url.includes('A_BillingDocument(')) {
    const id = url.match(/A_BillingDocument\('(\w+)'\)/)[1];
    if (!sap.invoices[id]) throw notFound();
    return ok(sap.invoices[id]);
  }
  if (method === 'GET' && url.includes('A_CustomerReturnItem?')) return ok({ results: sap.existingReturns });
  if (method === 'GET' && url.includes('A_CreditMemoRequest?')) return ok({ results: sap.existingCredits });
  if (method === 'GET' && url.includes('A_SlsPrcgCndnRecdValidity')) return ok({ results: sap.agreedPrices });

  if (method === 'GET' && url.includes('A_CustomerReturn(')) {
    return ok({ CustomerReturn: '60000001', OverallSDProcessStatus: 'B', GoodsMovementStatus: 'C', __metadata: { etag: 'W/"ret-v2"' } });
  }
  if (method === 'POST' && url.endsWith('/A_CustomerReturn')) {
    return ok({ CustomerReturn: '60000001', CustomerReturnType: 'YRE', SoldToParty: data.SoldToParty, __metadata: { etag: 'W/"ret-v1"' } });
  }
  if (method === 'POST' && url.endsWith('/A_CreditMemoRequest')) {
    return ok({ CreditMemoRequest: '70000001', CreditMemoRequestType: 'YCR', __metadata: { etag: 'W/"cr-v1"' } });
  }
  if (method === 'PATCH') return { data: '', headers: {} };

  throw new Error(`Unmocked SAP call: ${method} ${url}`);
});

let srv, AuditLog, InboundEmails;
beforeAll(async () => {
  srv = await cds.connect.to('ReturnsService');
  ({ AuditLog, InboundEmails } = srv.entities);
});

beforeEach(async () => {
  resetSap();
  await DELETE.from(AuditLog);
  await DELETE.from(InboundEmails);
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

// ---------------------------------------------------------------------------
describe('proposeAction', () => {
  test('R3 takes precedence over R1 for leaking goods', async () => {
    const res = await propose({ reason: 'damaged and leaking' });
    expect(res).toMatchObject({ rule: 'R3', proposedAction: 'CREDIT', creditValue: 20 });
  });

  test('R1 for transit damage, approver tier by value', async () => {
    const res = await propose({ reason: 'broken in transit' });
    expect(res).toMatchObject({ rule: 'R1', proposedAction: 'RETURN', requiredApprover: 'customer-service-lead' });
  });

  test('matches zero-padded SAP item numbers and works without a material', async () => {
    const res = await propose({ material: '', reason: 'defective' });
    expect(res.rule).toBe('R2');
  });

  test('R4 credits the price difference when overcharged', async () => {
    sap.agreedPrices = [{ ConditionRecord: '1', ConditionType: 'PR00', to_SlsPrcgConditionRecord: { ConditionRateValue: '8' } }];
    const res = await propose({ reason: 'wrong price' });
    expect(res).toMatchObject({ rule: 'R4', proposedAction: 'CREDIT', creditValue: 4 });
  });

  test('R4 without an agreed price is PENDING, not REJECT', async () => {
    const res = await propose({ reason: 'wrong price', soldToParty: '' });
    expect(res).toMatchObject({ rule: 'R4', proposedAction: 'PENDING' });
    // Falls back to the invoice's sold-to party for the price lookup
    expect(sap.calls.some((c) => c.url.includes('A_SlsPrcgCndnRecdValidity') && c.url.includes('100001'))).toBe(true);
  });

  test('R7 when claimed quantity exceeds invoice', async () => {
    expect((await propose({ quantity: 50, reason: 'defective' })).rule).toBe('R7');
  });

  test('R8 when SAP already has a return for the invoice', async () => {
    sap.existingReturns = [{ CustomerReturn: '60000009' }];
    expect((await propose({ reason: 'defective' })).rule).toBe('R8');
  });

  test('R9 for unknown invoice', async () => {
    expect((await propose({ invoiceNumber: '99999999', reason: 'defective' })).rule).toBe('R9');
  });

  test('rejects invoice numbers that could inject into the OData URL', async () => {
    await expect(propose({ invoiceNumber: "1') or ('1" })).rejects.toMatchObject({ code: 400 });
  });
});

// ---------------------------------------------------------------------------
describe('SAP outages', () => {
  test('proposeAction rejects with 503 instead of returning R9', async () => {
    sap.down = true;
    await expect(propose({ reason: 'defective' })).rejects.toMatchObject({ code: 503 });
  });

  test('a failing duplicate check is fatal, so no duplicate gets logged', async () => {
    sap.creditsDown = true;
    await expect(propose({ reason: 'defective' })).rejects.toMatchObject({ code: 503 });
  });

  test('complaint is FAILED (retryable), then logged once SAP is back', async () => {
    sap.down = true;
    const first = await srv.send('processComplaint', { text: 'Invoice 90000123, material TG11, 2 PC defective' });
    expect(first.status).toBe('FAILED');
    expect(await SELECT.one.from(InboundEmails).where({ ID: first.inboundEmailID })).toMatchObject({ status: 'FAILED', attempts: 1 });

    sap.down = false;
    const retry = await srv.send('reprocessInboundEmail', { ID: first.inboundEmailID });
    expect(retry).toMatchObject({ status: 'LOGGED', rule: 'R2' });
  });

  test('gives up and moves to NEEDS_REVIEW after EMAIL_MAX_ATTEMPTS failures', async () => {
    sap.down = true;
    const { inboundEmailID: ID } = await srv.send('processComplaint', { text: 'Invoice 90000123 2 PC defective' });
    expect((await srv.send('reprocessInboundEmail', { ID })).status).toBe('FAILED');
    const third = await srv.send('reprocessInboundEmail', { ID });
    expect(third.status).toBe('NEEDS_REVIEW');
    expect(third.statusReason).toMatch(/^Gave up after 3 attempts/);
  });
});

// ---------------------------------------------------------------------------
describe('setApprovalStatus', () => {
  const decide = (ID, status, approverRole = 'credit-manager') =>
    srv.send('setApprovalStatus', { ID, status, approvedBy: 'u1', approverRole });

  test('rejecting is allowed even when SAP already has a document', async () => {
    const ID = await auditEntry({ approvalStatus: 'PENDING', rule: 'R1', proposedAction: 'RETURN' });
    sap.existingReturns = [{ CustomerReturn: '60000009' }];
    expect((await decide(ID, 'REJECTED')).approvalStatus).toBe('REJECTED');
  });

  test('approving is blocked when SAP already has a document', async () => {
    const ID = await auditEntry({ approvalStatus: 'PENDING', rule: 'R1', proposedAction: 'RETURN' });
    sap.existingReturns = [{ CustomerReturn: '60000009' }];
    await expect(decide(ID, 'APPROVED')).rejects.toMatchObject({ code: 409 });
  });

  test('approving is blocked with 503 while SAP is down, and the request stays PENDING', async () => {
    const ID = await auditEntry({ approvalStatus: 'PENDING', rule: 'R1', proposedAction: 'RETURN' });
    sap.down = true;
    await expect(decide(ID, 'APPROVED')).rejects.toMatchObject({ code: 503 });
    expect((await SELECT.one.from(AuditLog).where({ ID })).approvalStatus).toBe('PENDING');
  });

  test('rejecting still works while SAP is down', async () => {
    const ID = await auditEntry({ approvalStatus: 'PENDING', rule: 'R1', proposedAction: 'RETURN' });
    sap.down = true;
    expect((await decide(ID, 'REJECTED')).approvalStatus).toBe('REJECTED');
  });

  test('insufficient role is refused', async () => {
    const ID = await auditEntry({ approvalStatus: 'PENDING', requiredApprover: 'finance-director' });
    await expect(decide(ID, 'APPROVED')).rejects.toMatchObject({ code: 403 });
  });

  test('already decided requests are refused before calling SAP', async () => {
    const ID = await auditEntry({ approvalStatus: 'APPROVED' });
    await expect(decide(ID, 'REJECTED')).rejects.toMatchObject({ code: 409 });
    expect(sap.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('document creation must match the approved entry', () => {
  const credit = (data) => srv.send('createCreditMemoRequest', {
    invoiceNumber: '90000123', invoiceItem: '10', material: 'TG11', quantity: '2', unit: 'PC',
    rule: 'R5', soldToParty: '100001', evidenceUrl: 'https://proof', ...data
  });

  test('an approved R7 rejection cannot be turned into a credit memo', async () => {
    const auditLogID = await auditEntry({ rule: 'R7', proposedAction: 'REJECT' });
    await expect(credit({ auditLogID })).rejects.toMatchObject({ code: 400 });
    expect(sap.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('an approval cannot be reused for another invoice', async () => {
    const auditLogID = await auditEntry({ rule: 'R5', proposedAction: 'CREDIT' });
    await expect(credit({ auditLogID, invoiceNumber: '90000999' })).rejects.toMatchObject({ code: 400 });
  });

  test('an approved R4 with no overcharge (REJECT) cannot create a credit memo', async () => {
    const auditLogID = await auditEntry({ rule: 'R4', proposedAction: 'REJECT', agreementApproved: true });
    await expect(credit({ auditLogID, rule: 'R4' })).rejects.toMatchObject({ code: 400 });
  });

  test('happy path stores the OData v2 ETag', async () => {
    const auditLogID = await auditEntry({ rule: 'R5', proposedAction: 'CREDIT' });
    const res = await credit({ auditLogID });
    expect(res).toMatchObject({ CreditMemoRequest: '70000001', SalesDocumentType: 'YCR', sapDocumentVersion: 'W/"cr-v1"' });
    const row = await SELECT.one.from(AuditLog).where({ ID: auditLogID });
    expect(row).toMatchObject({ sapDocument: '70000001', sapDocumentVersion: 'W/"cr-v1"', warehouseCheckNeeded: true });
  });

  test('createReturn returns CustomerReturnType and the ETag', async () => {
    const auditLogID = await auditEntry({ rule: 'R2', proposedAction: 'RETURN' });
    const res = await srv.send('createReturn', {
      auditLogID, invoiceNumber: '90000123', invoiceItem: '10', material: 'TG11',
      quantity: '2', unit: 'PC', rule: 'R2', soldToParty: '100001'
    });
    expect(res).toMatchObject({ CustomerReturn: '60000001', CustomerReturnType: 'YRE', sapDocumentVersion: 'W/"ret-v1"' });
  });
});

// ---------------------------------------------------------------------------
describe('release and status', () => {
  test('releaseCustomerReturn fetches the current ETag when none is given', async () => {
    const res = await srv.send('releaseCustomerReturn', { returnDocumentNumber: '60000001' });
    expect(res.status).toBe('RELEASED');
    const patch = sap.calls.find((c) => c.method === 'PATCH');
    expect(patch.headers['If-Match']).toBe('W/"ret-v2"');
  });

  test('getReturnStatus reports goods movement', async () => {
    const res = await srv.send('getReturnStatus', { returnDocumentNumber: '60000001' });
    expect(res).toMatchObject({ overallProcessingStatus: 'B', goodsMovementStatus: 'C', received: true });
  });
});

// ---------------------------------------------------------------------------
describe('complaint intake (front end / agent)', () => {
  test('processComplaint over HTTP logs a clear complaint', async () => {
    const { data } = await POST('/odata/v4/returns/processComplaint', {
      subject: 'Defective goods',
      text: 'Invoice 90000123, material TG11, 2 PC are defective.',
      from: 'buyer@customer.com'
    });
    expect(data).toMatchObject({ status: 'LOGGED', rule: 'R2', invoiceItem: '10' });

    const audit = await SELECT.one.from(AuditLog).where({ ID: data.auditLogID });
    expect(audit).toMatchObject({ rule: 'R2', material: 'TG11', invoiceItem: '10', approvalStatus: 'PENDING' });
    const email = await SELECT.one.from(InboundEmails).where({ ID: data.inboundEmailID });
    expect(email).toMatchObject({ status: 'LOGGED', fromAddress: 'buyer@customer.com', auditLog_ID: data.auditLogID });
  });

  test('unclear complaint is stored as NEEDS_REVIEW, agent fixes it via reprocessInboundEmail', async () => {
    const first = await srv.send('processComplaint', { subject: 'Problem', text: 'Something is wrong with our order' });
    expect(first).toMatchObject({ status: 'NEEDS_REVIEW', statusReason: 'No invoice number found' });

    const fixed = await srv.send('reprocessInboundEmail', {
      ID: first.inboundEmailID, invoiceNumber: '90000123', material: 'TG11', quantity: 2, reason: 'goods are defective'
    });
    expect(fixed).toMatchObject({ status: 'LOGGED', rule: 'R2', inboundEmailID: first.inboundEmailID });
    expect(await SELECT.from(InboundEmails)).toHaveLength(1);

    // Re-running a logged complaint never creates a second audit entry
    await expect(srv.send('reprocessInboundEmail', { ID: first.inboundEmailID })).rejects.toMatchObject({ code: 409 });
    expect(await SELECT.from(AuditLog)).toHaveLength(1);
  });

  test('R9 from proposeAction is NEEDS_REVIEW with the reasoning', async () => {
    const res = await srv.send('processComplaint', { text: 'Invoice 99999999 goods defective' });
    expect(res.status).toBe('NEEDS_REVIEW');
    expect(res.rule).toBe('R9');
  });

  test('parseComplaint only parses', async () => {
    const res = await srv.send('parseComplaint', { text: 'Invoice 90000123 is overcharged' });
    expect(res).toMatchObject({ invoiceNumber: '90000123', proposedAction: 'CREDIT' });
    expect(await SELECT.from(InboundEmails)).toHaveLength(0);
  });

  test('pollInbox reports missing email configuration', async () => {
    await expect(srv.send('pollInbox')).rejects.toMatchObject({ code: 503 });
  });
});
