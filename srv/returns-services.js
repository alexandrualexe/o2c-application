// =============================================================================
// ReturnsService implementation (handlers for srv/returns-services.cds)
// -----------------------------------------------------------------------------
// The service is the "hands" of the returns agent. It does three things:
//
//   1. DECIDE   proposeAction runs the R1–R9 decision tree against the real
//               invoice in SAP and proposes RETURN / CREDIT / REPLACEMENT /
//               REJECT / PENDING plus a credit value and an approver tier.
//   2. CONTROL  logRequest / setApprovalStatus / confirmSpecialAgreement keep
//               an audit trail in our own database. Nothing is created in SAP
//               without an APPROVED audit entry that matches the request.
//   3. ACT      createReturn / createCreditMemoRequest create the SAP document
//               with billing block 08; release* removes the block afterwards.
//
// All SAP calls go through the BTP destination "DS4" (SAP S/4HANA, client 100)
// via the SAP Cloud SDK, using the standard OData v2 APIs:
//   API_BILLING_DOCUMENT_SRV         invoices
//   API_CUSTOMER_RETURN_SRV          customer returns (YRE)
//   API_CREDIT_MEMO_REQUEST_SRV      credit memo requests (YCR)
//   API_SLSPRICINGCONDITIONRECORD_SRV  agreed prices (PR00)
//
// Rule overview:
//   R1 damaged in transit   -> RETURN (YRE)   R6 replacement        -> customer service
//   R2 poor quality/defect  -> RETURN (YRE)   R7 claim > invoice    -> REJECT
//   R3 ruined, no return    -> CREDIT (YCR)   R8 duplicate          -> REJECT
//   R4 price above agreed   -> CREDIT (YCR)   R9 unclear/not found  -> PENDING (ask)
//   R5 short delivery       -> CREDIT (YCR)
// =============================================================================

const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

// BTP destination pointing to the S/4HANA system, and its SAP client
const DEST = 'DS4';
const SAP_CLIENT = '100';

// Rule definitions with all metadata
//   proposedAction   what proposeAction returns for the rule
//   sdDocumentType   SAP document created on approval (YRE return, YCR credit memo, null = none)
//   orderReason      SAP order reason (SDDocumentReason) written to the document
//   creditAfterReceipt  credit is only given once the goods are back in the warehouse
//   requiresEvidence    photo (R3) or proof of delivery (R5) needed
//   creditManager       always needs at least a credit manager, regardless of value
//   requiresAgreement   R4: special price agreement must be confirmed first
//   requiresWarehouseCheck  R5: warehouse has to confirm the short delivery
const RULES = {
  R1: {
    proposedAction: 'RETURN',
    sdDocumentType: 'YRE',
    orderReason: '102',
    description: 'Goods damaged in transit (recoverable)',
    creditAfterReceipt: true,
    requiresEvidence: false
  },
  R2: {
    proposedAction: 'RETURN',
    sdDocumentType: 'YRE',
    orderReason: '101',
    description: 'Poor quality / defective',
    creditAfterReceipt: true,
    requiresEvidence: false
  },
  R3: {
    proposedAction: 'CREDIT',
    sdDocumentType: 'YCR',
    orderReason: '104',
    description: 'Goods ruined, credit only (non-recoverable)',
    creditAfterReceipt: false,
    requiresEvidence: true,
    creditManager: true
  },
  R4: {
    proposedAction: 'CREDIT',
    sdDocumentType: 'YCR',
    orderReason: '101',
    description: 'Price higher than agreed',
    creditAfterReceipt: false,
    requiresEvidence: false,
    creditManager: true,
    requiresAgreement: true
  },
  R5: {
    proposedAction: 'CREDIT',
    sdDocumentType: 'YCR',
    orderReason: '103',
    description: 'Short delivery',
    creditAfterReceipt: false,
    requiresEvidence: true,
    creditManager: true,
    requiresWarehouseCheck: true
  },
  R6: {
    proposedAction: 'REPLACEMENT',
    sdDocumentType: null,
    orderReason: null,
    description: 'Replacement, hand to customer service',
    creditAfterReceipt: false,
    requiresEvidence: false
  },
  R7: {
    proposedAction: 'REJECT',
    sdDocumentType: null,
    orderReason: null,
    description: 'Claimed quantity exceeds invoice',
    creditAfterReceipt: false,
    requiresEvidence: false
  },
  R8: {
    proposedAction: 'REJECT',
    sdDocumentType: null,
    orderReason: null,
    description: 'Duplicate complaint',
    creditAfterReceipt: false,
    requiresEvidence: false
  },
  R9: {
    proposedAction: 'PENDING',
    sdDocumentType: null,
    orderReason: null,
    description: 'Invoice not named or found, search needed',
    creditAfterReceipt: false,
    requiresEvidence: false
  }
};

// Approval tier mapping by credit value and rule
//   up to 500 EUR   -> customer-service-lead
//   up to 5000 EUR  -> credit-manager
//   above           -> finance-director
// A higher role may always approve on behalf of a lower one (see setApprovalStatus).
function getRequiredApprover(creditValue, rule) {
  const ruleData = RULES[rule] || {};

  // R3, R4, R5 always need at least credit manager (no goods back, or special handling)
  if (ruleData.creditManager) {
    return 'credit-manager';
  }

  // R1, R2: tier by value
  if (creditValue <= 500) return 'customer-service-lead';
  if (creditValue <= 5000) return 'credit-manager';
  return 'finance-director';
}

// Generic request helper: every SAP call goes through the DS4 destination and
// carries the sap-client header. The destination service supplies URL and auth;
// the connectivity service tunnels the call to the on-premise system.
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

// CSRF token + cookies for POST/PATCH calls
// SAP Gateway rejects modifying requests without a CSRF token. The token is
// fetched with a GET on the service root and is only valid together with the
// session cookies of that same response, so both are returned and sent along.
async function getCsrfTokenAndCookies(servicePath) {
  const response = await executeHttpRequest(
    { destinationName: DEST },
    {
      method: 'GET',
      url: `${servicePath}/`,
      headers: { 'x-csrf-token': 'Fetch', 'sap-client': SAP_CLIENT }
    },
    { fetchCsrfToken: false }   // We handle the token ourselves (see above)
  );
  const setCookie = response.headers['set-cookie'];
  return {
    csrfToken: response.headers['x-csrf-token'],
    // "name=value; Path=/; HttpOnly" -> keep only "name=value", join all cookies
    cookies: Array.isArray(setCookie)
      ? setCookie.map((c) => c.split(';')[0]).join('; ')
      : ''
  };
}

// Read a document's current ETag (the stored one goes stale once SAP changes the document, e.g. goods receipt)
async function fetchCurrentEtag(entityPath) {
  const response = await callDestination('GET', `${entityPath}?$format=json`);
  const etag = getEtag(response, unwrap(response.data));
  if (!etag) throw new Error(`No ETag returned for ${entityPath}`);
  return etag;
}

// Convert backend errors into proper CAP errors
// Passes SAP's HTTP status (404, 400, ...) and message through to the caller,
// so the agent sees e.g. "createReturn failed: Material 54 is blocked" instead
// of a generic 500.
function handleError(req, err, context) {
  const status = err.response?.status;
  const backendMsg =
    err.response?.data?.error?.message?.value ||   // SAP OData v2 error format
    err.response?.data?.error?.message ||
    err.message;                                    // Network / destination errors
  console.error(`${context} failed:`, status, backendMsg);
  return req.reject(status || 500, `${context} failed: ${backendMsg}`);
}

// SAP OData v2 returns { d: ... }
// unwrap() strips that envelope; collections come back as { results: [...] }.
const unwrap = (data) => (data && data.d !== undefined ? data.d : data);

// SAP document numbers (invoice, return, credit memo) are interpolated into OData URLs, so restrict them
// (prevents a value like "1') or ('1" from changing the query)
const isDocNumber = (v) => typeof v === 'string' && /^[A-Za-z0-9]{1,10}$/.test(v);

// OData v2 puts the ETag in __metadata.etag; the ETag response header is the fallback
// The ETag is SAP's optimistic-locking version stamp: a PATCH must send it in
// If-Match, and SAP refuses the change if the document was modified meanwhile.
const getEtag = (response, doc) => doc?.__metadata?.etag || response?.headers?.etag || null;

// Returns an error message if the request doesn't match the approved audit entry, else null
// An approval is for one specific complaint. Without this check, an approved
// R7 rejection (or an approval for another invoice) could be reused to create
// a credit memo nobody approved.
function approvalMismatch(auditLog, { invoiceNumber, rule }) {
  if (auditLog.invoiceNumber !== invoiceNumber) {
    return `invoiceNumber ${invoiceNumber} does not match approved request (${auditLog.invoiceNumber})`;
  }
  if (auditLog.rule !== rule) {
    return `rule ${rule} does not match approved request (${auditLog.rule})`;
  }
  // e.g. R4 approved as REJECT (no overcharge found) must not become a CREDIT
  if (auditLog.proposedAction !== RULES[rule].proposedAction) {
    return `Approved request is ${auditLog.proposedAction}, not ${RULES[rule].proposedAction}; no document can be created`;
  }
  return null;
}

// CAP calls this with the ReturnsService instance; all handlers are registered here
module.exports = function (srv) {
  const { AuditLog } = srv.entities;

  // ---- proposeAction: R1-R9 decision tree ----
  // Reads the invoice from SAP and decides which rule applies. Order of checks:
  //   invoice / line item exists?        no  -> R9
  //   claim larger than invoice?         yes -> R7
  //   already a document for invoice?    yes -> R8 (our audit log, then SAP)
  //   reason keywords                        -> R3, R1, R2, R4, R5, R6
  //   nothing matched                        -> R9 (ask the customer)
  // Only proposes; nothing is stored or created here.
  srv.on('proposeAction', async (req) => {
    const { invoiceNumber, invoiceItem, material, quantity, claimedAmount, reason, soldToParty } = req.data;

    if (!isDocNumber(invoiceNumber)) {
      return req.reject(400, 'invoiceNumber must be 1–10 letters or digits');
    }

    try {
      // Get the invoice to validate
      const invResponse = await callDestination(
        'GET',
        `/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV/A_BillingDocument('${invoiceNumber}')?$expand=to_Item&$format=json`
      );
      const invoice = unwrap(invResponse.data);

      if (!invoice) {
        return {
          rule: 'R9',
          proposedAction: 'PENDING',
          reasoning: 'Invoice not found. Use findInvoices to search for alternatives.',
          creditValue: 0,
          requiresApproval: false,
          requiredApprover: null
        };
      }

      // Find the line item
      // Both item number and material must match the invoice line (e.g. item '10', material '54')
      const lineItem = (invoice.to_Item?.results || []).find(
        (i) => i.BillingDocumentItem === invoiceItem && i.Material === material
      );

      if (!lineItem) {
        return {
          rule: 'R9',
          proposedAction: 'PENDING',
          reasoning: 'Line item not found. Please verify invoice and material number.',
          creditValue: 0,
          requiresApproval: false,
          requiredApprover: null
        };
      }

      // SAP sends numbers as strings; derive the unit price for credit calculations
      const invoicedQty = parseFloat(lineItem.BillingQuantity) || 0;
      const invoicedAmount = parseFloat(lineItem.NetAmount) || 0;
      const invoicedPrice = invoicedQty > 0 ? invoicedAmount / invoicedQty : 0;

      // R7: Claimed quantity exceeds invoice
      if (quantity > invoicedQty) {
        return {
          rule: 'R7',
          proposedAction: 'REJECT',
          reasoning: `Claimed quantity ${quantity} ${lineItem.BillingQuantityUnit} exceeds invoiced ${invoicedQty}. Ask customer to verify.`,
          creditValue: 0,
          requiresApproval: true,
          requiredApprover: 'customer-service-lead'
        };
      }

      // R7 also applies when the claimed money exceeds the invoiced amount
      if (claimedAmount > invoicedAmount) {
        return {
          rule: 'R7',
          proposedAction: 'REJECT',
          reasoning: `Claimed amount ${claimedAmount} exceeds invoiced ${invoicedAmount}. Ask customer to verify.`,
          creditValue: 0,
          requiresApproval: true,
          requiredApprover: 'customer-service-lead'
        };
      }

      // R8: Check for existing approved complaints
      // First in our own audit log: an approved entry that already produced a document
      const tx = cds.tx(req);
      const existingApproved = await tx.run(
        SELECT.one.from(AuditLog).where({
          invoiceNumber,
          approvalStatus: 'APPROVED',
          sapDocument: { '!=': null }
        })
      );

      if (existingApproved) {
        return {
          rule: 'R8',
          proposedAction: 'REJECT',
          reasoning: `Duplicate: ${existingApproved.sapDocumentType} ${existingApproved.sapDocument} already exists for invoice ${invoiceNumber} under rule ${existingApproved.rule}.`,
          creditValue: 0,
          requiresApproval: false,
          requiredApprover: null
        };
      }

      // Also check SAP for existing returns/credit memos
      // (catches documents created manually in SAP, outside this app).
      // srv.send calls our own checkExistingCredits handler; cds.tx(req).send
      // would go to the database service and silently return undefined.
      try {
        const existingCreds = await srv.send('checkExistingCredits', { invoiceNumber });
        if ((existingCreds.existingReturns?.length > 0) || (existingCreds.existingCredits?.length > 0)) {
          const existing = existingCreds.existingReturns?.[0] || existingCreds.existingCredits?.[0];
          return {
            rule: 'R8',
            proposedAction: 'REJECT',
            reasoning: `Duplicate in SAP: ${existing.CustomerReturn || existing.CreditMemoRequest} already exists for this invoice.`,
            creditValue: 0,
            requiresApproval: false,
            requiredApprover: null
          };
        }
      } catch (err) {
        // Non-fatal: if the lookup fails, continue; setApprovalStatus checks again before approval
        console.warn('checkExistingCredits failed (non-fatal):', err.message);
      }

      // Normalize reason to lowercase for keyword matching
      const lowerReason = (reason || '').toLowerCase();

      // ---- RULE PRECEDENCE ----
      // R3 must come BEFORE R1 because "damaged and leaking" should be R3, not R1

      // R3: Irrecoverable goods (ruined, leaking, contaminated)
      // Credit for the claimed quantity, or the whole line if no quantity was given
      if (lowerReason.includes('ruined') || lowerReason.includes('leak') || lowerReason.includes('contaminat')) {
        const creditValue = quantity > 0 ? quantity * invoicedPrice : invoicedAmount;
        return {
          rule: 'R3',
          proposedAction: 'CREDIT',
          reasoning: `${RULES.R3.description}. Credit only, no return. Requires photo/evidence of damage.`,
          creditValue,
          requiresApproval: true,
          requiredApprover: 'credit-manager'
        };
      }

      // R1: Recoverable goods damaged in transit
      if (lowerReason.includes('damage') || lowerReason.includes('transit') || lowerReason.includes('broken')) {
        const creditValue = quantity > 0 ? quantity * invoicedPrice : invoicedAmount;
        return {
          rule: 'R1',
          proposedAction: 'RETURN',
          reasoning: `${RULES.R1.description}. Return the goods; credit after warehouse receipt.`,
          creditValue,
          requiresApproval: true,
          requiredApprover: getRequiredApprover(creditValue, 'R1')
        };
      }

      // R2: Quality/defect issues
      if (lowerReason.includes('quality') || lowerReason.includes('defect') || lowerReason.includes('faulty')) {
        const creditValue = quantity > 0 ? quantity * invoicedPrice : invoicedAmount;
        return {
          rule: 'R2',
          proposedAction: 'RETURN',
          reasoning: `${RULES.R2.description}. Return the goods; credit after warehouse receipt.`,
          creditValue,
          requiresApproval: true,
          requiredApprover: getRequiredApprover(creditValue, 'R2')
        };
      }

      // R4: Price overcharge (requires PR00 verification)
      // Compares the invoiced unit price with the agreed PR00 price in SAP
      if (lowerReason.includes('price') || lowerReason.includes('expensive') || lowerReason.includes('overcharg')) {
        // Query agreed price from SAP PR00 condition
        let agreedPrice = invoicedPrice; // Default to invoiced price
        try {
          const priceResult = await srv.send('getAgreedPrice', {
            soldToParty: soldToParty || '',
            material: material || '',
            salesOrganization: invoice.SalesOrganization,
            distributionChannel: invoice.DistributionChannel
          });

          if (priceResult.agreedPrices?.length > 0) {
            agreedPrice = parseFloat(priceResult.agreedPrices[0].ConditionRateValue) || invoicedPrice;
          }
        } catch (err) {
          // e.g. missing soldToParty: keep agreedPrice = invoicedPrice (no overcharge detected)
          console.warn('getAgreedPrice failed:', err.message);
        }

        // Detect overcharge
        if (invoicedPrice > agreedPrice) {
          // Credit only the difference, for the claimed quantity
          const creditAmount = (invoicedPrice - agreedPrice) * quantity;
          return {
            rule: 'R4',
            proposedAction: 'CREDIT',
            reasoning: `${RULES.R4.description}. Invoice: ${invoicedPrice}/unit, Agreed: ${agreedPrice}/unit. Requires special agreement confirmation.`,
            creditValue: creditAmount,
            requiresApproval: true,
            requiredApprover: 'credit-manager'
          };
        } else {
          // No overcharge detected
          return {
            rule: 'R4',
            proposedAction: 'REJECT',
            reasoning: `Price claim not supported. Invoiced price (${invoicedPrice}/unit) matches agreed price (${agreedPrice}/unit).`,
            creditValue: 0,
            requiresApproval: true,
            requiredApprover: 'credit-manager'
          };
        }
      }

      // R5: Short delivery (quantity billed < ordered quantity)
      if (lowerReason.includes('short') || lowerReason.includes('missing') || lowerReason.includes('incomplete')) {
        // For now, assume claimed quantity < invoiced quantity means short delivery
        // In production, compare against original sales order
        const creditValue = quantity > 0 ? quantity * invoicedPrice : invoicedAmount;
        return {
          rule: 'R5',
          proposedAction: 'CREDIT',
          reasoning: `${RULES.R5.description}. Claimed ${quantity}, invoiced ${invoicedQty}. Requires warehouse confirmation or proof of delivery.`,
          creditValue,
          requiresApproval: true,
          requiredApprover: 'credit-manager'
        };
      }

      // R6: Replacement request (hand to customer service, no SAP document)
      if (lowerReason.includes('replace') || lowerReason.includes('substitut') || lowerReason.includes('send another')) {
        return {
          rule: 'R6',
          proposedAction: 'REPLACEMENT',
          reasoning: `${RULES.R6.description}. Escalate to customer service for replacement logistics.`,
          creditValue: 0,
          requiresApproval: true,
          requiredApprover: 'customer-service-lead'
        };
      }

      // R9: Reason unclear or unmatched
      // The agent should ask the customer which of the cases applies
      return {
        rule: 'R9',
        proposedAction: 'PENDING',
        reasoning: `Reason unclear: "${reason}". Please clarify: damaged/defective (R1/R2), ruined (R3), price issue (R4), short delivery (R5), or replacement (R6)?`,
        creditValue: 0,
        requiresApproval: false,
        requiredApprover: null
      };
    } catch (err) {
      // Invoice lookup failed (not found in SAP, or SAP unreachable): treat as R9
      console.error('proposeAction error:', err.message);
      return {
        rule: 'R9',
        proposedAction: 'PENDING',
        reasoning: `Error looking up invoice: ${err.message}`,
        creditValue: 0,
        requiresApproval: false,
        requiredApprover: null
      };
    }
  });

  // ---- checkPrice: R4 price verification ----
  // Pure calculation, no SAP call: useful when the agent already knows both prices
  srv.on('checkPrice', async (req) => {
    const { invoicedPrice, agreedPrice, quantity } = req.data;

    const overcharged = invoicedPrice > agreedPrice;
    const creditAmount = overcharged ? (invoicedPrice - agreedPrice) * quantity : 0;

    return {
      invoicedPrice,
      agreedPrice,
      overcharged,
      creditAmount
    };
  });

  // ---- logRequest: create a pending audit entry with rule and credit value ----
  // Called after proposeAction (by the agent or the email listener). The entry
  // starts as PENDING; the required approver tier is derived from rule and value.
  srv.on('logRequest', async (req) => {
    const { invoiceNumber, proposedAction, rule, reason, claimedQuantity, claimedAmount, creditValue, evidenceUrl } = req.data;

    // Validate rule
    if (!RULES[rule]) {
      return req.reject(400, `rule must be one of: ${Object.keys(RULES).join(', ')}`);
    }

    // Validate invoice number
    if (
      typeof invoiceNumber !== 'string' ||
      !/^[A-Za-z0-9]{1,10}$/.test(invoiceNumber)
    ) {
      return req.reject(400, 'invoiceNumber must be 1–10 letters or digits');
    }

    const ID = cds.utils.uuid();
    const tx = cds.tx(req);   // Same transaction as the request: committed when it succeeds
    const requiredApprover = getRequiredApprover(creditValue || 0, rule);

    await tx.run(
      INSERT.into(AuditLog).entries({
        ID,
        invoiceNumber,
        proposedAction,
        rule,
        reason,
        claimedQuantity: claimedQuantity || 0,
        claimedAmount: claimedAmount || 0,
        approvalStatus: 'PENDING',
        creditValue: creditValue || 0,
        creditCurrency: 'EUR',
        requiredApprover,
        evidenceUrl
      })
    );

    // Return the full row (incl. defaults and managed fields)
    return tx.run(SELECT.one.from(AuditLog).where({ ID }));
  });

  // ---- setApprovalStatus: decide a pending request ----
  // CHANGE 5: Re-check SAP before approval to catch duplicates created between investigation and approval
  srv.on('setApprovalStatus', async (req) => {
    const { ID, status, approvedBy, approverRole } = req.data;

    // --- Input checks ---
    if (!ID) {
      return req.reject(400, 'ID is required');
    }

    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return req.reject(400, 'status must be APPROVED or REJECTED');
    }

    if (!approvedBy) {
      return req.reject(400, 'approvedBy (user ID) is required');
    }

    if (!approverRole) {
      return req.reject(400, 'approverRole is required');
    }

    const tx = cds.tx(req);

    // Get the audit log to check tier
    const auditLog = await tx.run(SELECT.one.from(AuditLog).where({ ID }));
    if (!auditLog) {
      return req.reject(404, `Request ${ID} not found`);
    }

    // Check if approver role is sufficient
    // Key = required tier, value = roles allowed to decide (that tier or higher)
    const allowedRoles = {
      'customer-service-lead': ['customer-service-lead', 'credit-manager', 'finance-director'],
      'credit-manager': ['credit-manager', 'finance-director'],
      'finance-director': ['finance-director']
    };

    const required = auditLog.requiredApprover;
    if (!allowedRoles[required] || !allowedRoles[required].includes(approverRole)) {
      return req.reject(403, `Role ${approverRole} cannot approve. Required: ${required}`);
    }

    // CHANGE 5: Re-check SAP before approval to catch duplicates (rejecting is always allowed)
    if (status === 'APPROVED') {
      try {
        const existingCreds = await srv.send('checkExistingCredits', { invoiceNumber: auditLog.invoiceNumber });
        if ((existingCreds.existingReturns?.length > 0) || (existingCreds.existingCredits?.length > 0)) {
          const existing = existingCreds.existingReturns?.[0] || existingCreds.existingCredits?.[0];
          return req.reject(409, `Duplicate in SAP: ${existing.CustomerReturn || existing.CreditMemoRequest} already exists for this invoice. Approval blocked.`);
        }
      } catch (err) {
        // SAP unreachable: the approval still goes through (document creation will fail anyway if SAP is down)
        console.warn('Re-check checkExistingCredits failed (non-fatal):', err.message);
      }
    }

    // Update status
    // The "approvalStatus: 'PENDING'" condition makes this atomic: if two
    // approvers click at the same time, only the first update changes a row.
    const updated = await tx.run(
      UPDATE(AuditLog)
        .set({
          approvalStatus: status,
          approvedBy,
          approverRole,
          decidedAt: new Date()
        })
        .where({ ID, approvalStatus: 'PENDING' })
    );

    // 0 rows updated -> it was already decided
    if (!updated) {
      return req.reject(
        409,
        `Request ${ID} is already ${auditLog.approvalStatus}`
      );
    }

    return tx.run(SELECT.one.from(AuditLog).where({ ID }));
  });

  // ---- confirmSpecialAgreement: R4 - unlock credit after special agreement confirmed ----
  // R4 credit memos are only allowed once someone confirms the customer really
  // has the lower agreed price (createCreditMemoRequest checks this flag).
  srv.on('confirmSpecialAgreement', async (req) => {
    const { ID } = req.data;

    if (!ID) {
      return req.reject(400, 'ID is required');
    }

    const tx = cds.tx(req);
    const auditLog = await tx.run(SELECT.one.from(AuditLog).where({ ID }));

    if (!auditLog) {
      return req.reject(404, `Request ${ID} not found`);
    }

    if (auditLog.rule !== 'R4') {
      return req.reject(400, 'confirmSpecialAgreement only works for R4 (price) rules');
    }

    await tx.run(
      UPDATE(AuditLog).set({ agreementApproved: true }).where({ ID })
    );

    return tx.run(SELECT.one.from(AuditLog).where({ ID }));
  });

  // ---- getInvoice ----
  // Billing document header + items, passed through from SAP
  srv.on('getInvoice', async (req) => {
    const { invoiceNumber } = req.data;
    if (!isDocNumber(invoiceNumber)) {
      return req.reject(400, 'invoiceNumber must be 1–10 letters or digits');
    }
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

  // ---- checkExistingCredits: R8 - check for duplicate complaints ----
  // Looks in SAP for return items and credit memo requests that reference the
  // invoice (ReferenceSDDocument). Both queries run in parallel.
  srv.on('checkExistingCredits', async (req) => {
    const { invoiceNumber } = req.data;
    if (!isDocNumber(invoiceNumber)) {
      return req.reject(400, 'invoiceNumber must be 1–10 letters or digits');
    }
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

  // ---- createReturn: R1, R2 - return goods and block for credit after receipt ----
  // Creates an SAP customer return (YRE) for an APPROVED R1/R2 entry. The
  // document carries billing block 08, so no credit is issued until it is
  // released (after the goods are received).
  srv.on('createReturn', async (req) => {
    const {
      auditLogID,
      invoiceNumber,
      invoiceItem,
      material,
      quantity,
      unit,
      rule,
      soldToParty,
      creditValue
    } = req.data;

    if (!auditLogID) {
      return req.reject(400, 'auditLogID is required');
    }

    // Validate rule is RETURN type
    if (!rule || RULES[rule]?.sdDocumentType !== 'YRE') {
      return req.reject(400, `Rule ${rule} is not a RETURN rule (R1 or R2)`);
    }

    const tx = cds.tx(req);

    // Re-read the audit entry and verify it's approved
    const auditLog = await tx.run(SELECT.one.from(AuditLog).where({ ID: auditLogID }));
    if (!auditLog) {
      return req.reject(404, `Audit log ${auditLogID} not found`);
    }

    if (auditLog.approvalStatus !== 'APPROVED') {
      return req.reject(400, `Audit log must be APPROVED before document creation`);
    }

    // One approval = one document
    if (auditLog.sapDocument) {
      return req.reject(409, `Document already created: ${auditLog.sapDocumentType} ${auditLog.sapDocument}`);
    }

    // The document must match what was approved (no reusing an approval for another invoice or rule)
    const mismatch = approvalMismatch(auditLog, { invoiceNumber, rule });
    if (mismatch) {
      return req.reject(400, mismatch);
    }

    // Check for duplicate in SAP
    // (via our audit log: another approved R1/R2 entry for this invoice already has a return)
    const existing = await tx.run(
      SELECT.one.from(AuditLog).where({
        invoiceNumber,
        rule: { in: ['R1', 'R2'] },
        approvalStatus: 'APPROVED',
        sapDocument: { '!=': null }
      })
    );
    if (existing && existing.ID !== auditLogID) {
      return req.reject(409, `Return already exists: ${existing.sapDocument} for rule ${existing.rule}`);
    }

    const servicePath = '/sap/opu/odata/sap/API_CUSTOMER_RETURN_SRV';
    const orderReason = RULES[rule].orderReason;

    try {
      const { csrfToken, cookies } = await getCsrfTokenAndCookies(servicePath);

      // CHANGE 4: Set Cust. Reference to COMPLAINT-<invoice> only (removed rule and UUID suffix)
      // Organisational data is fixed for the demo company (sales org YSOD, channel Y1, division Y5).
      // The item references the invoice line, so SAP copies price and conditions from it.
      const payload = {
        CustomerReturnType: 'YRE',
        SalesOrganization: 'YSOD',
        DistributionChannel: 'Y1',
        OrganizationDivision: 'Y5',
        SoldToParty: soldToParty,
        SDDocumentReason: orderReason,
        PurchaseOrderByCustomer: `COMPLAINT-${invoiceNumber}`,
        HeaderBillingBlockReason: '08', // Billing block: Check Credit Memo
        to_Item: [{
          Material: material,
          RequestedQuantity: quantity,
          RequestedQuantityUnit: unit,
          ReferenceSDDocument: invoiceNumber,
          ReferenceSDDocumentItem: invoiceItem
        }]
      };

      console.log('createReturn payload:', JSON.stringify(payload, null, 2));

      // Deep insert: header and item in one POST
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

      const returnDoc = unwrap(response.data);

      // Update audit log with SAP document number
      // (and the ETag, so the document can be released later)
      await tx.run(
        UPDATE(AuditLog)
          .set({
            sapDocument: returnDoc.CustomerReturn,
            sapDocumentType: 'YRE',
            sapDocumentVersion: getEtag(response, returnDoc)
          })
          .where({ ID: auditLogID })
      );

      // Every field returned here must also be declared in CreateReturnResult (CDS)
      return {
        CustomerReturn: returnDoc.CustomerReturn,
        CustomerReturnType: returnDoc.CustomerReturnType,
        SoldToParty: returnDoc.SoldToParty,
        SDDocumentReason: returnDoc.SDDocumentReason,
        TotalNetAmount: returnDoc.TotalNetAmount,
        TransactionCurrency: returnDoc.TransactionCurrency,
        OverallSDProcessStatus: returnDoc.OverallSDProcessStatus,
        sapDocumentVersion: getEtag(response, returnDoc)
      };
    } catch (err) {
      return handleError(req, err, 'createReturn');
    }
  });

  // ---- createCreditMemoRequest: R3, R4, R5 - credit without or before goods return ----
  // Creates an SAP credit memo request (YCR) for an APPROVED R3/R4/R5 entry,
  // also with billing block 08. Rule-specific preconditions:
  //   R3 photo evidence, R4 confirmed special agreement, R5 proof of delivery.
  srv.on('createCreditMemoRequest', async (req) => {
    const {
      auditLogID,
      invoiceNumber,
      invoiceItem,
      material,
      quantity,
      unit,
      rule,
      soldToParty,
      creditValue,
      evidenceUrl
    } = req.data;

    if (!auditLogID) {
      return req.reject(400, 'auditLogID is required');
    }

    // SAP needs the real item number (e.g. '10') to copy the invoice line
    if (typeof invoiceItem !== 'string' || !/^\d{1,6}$/.test(invoiceItem)) {
      return req.reject(400, 'invoiceItem must be the numeric item number from the invoice (1-6 digits)');
    }

    // Validate rule is CREDIT type
    if (!rule || RULES[rule]?.sdDocumentType !== 'YCR') {
      return req.reject(400, `Rule ${rule} is not a CREDIT rule (R3, R4, or R5)`);
    }

    const tx = cds.tx(req);

    // Re-read the audit entry and verify it's approved
    const auditLog = await tx.run(SELECT.one.from(AuditLog).where({ ID: auditLogID }));
    if (!auditLog) {
      return req.reject(404, `Audit log ${auditLogID} not found`);
    }

    if (auditLog.approvalStatus !== 'APPROVED') {
      return req.reject(400, `Audit log must be APPROVED before document creation`);
    }

    // One approval = one document
    if (auditLog.sapDocument) {
      return req.reject(409, `Document already created: ${auditLog.sapDocumentType} ${auditLog.sapDocument}`);
    }

    // The document must match what was approved (no reusing an approval for another invoice or rule)
    const mismatch = approvalMismatch(auditLog, { invoiceNumber, rule });
    if (mismatch) {
      return req.reject(400, mismatch);
    }

    // R3 requires evidence
    if (rule === 'R3' && !evidenceUrl) {
      return req.reject(400, 'Rule R3 (credit only) requires evidenceUrl (photo proof)');
    }

    // R5 requires evidence (warehouse check)
    if (rule === 'R5' && !evidenceUrl) {
      return req.reject(400, 'Rule R5 (short delivery) requires evidenceUrl (proof of delivery)');
    }

    // R4 requires special agreement to be confirmed
    if (rule === 'R4' && !auditLog.agreementApproved) {
      return req.reject(400, 'Rule R4 requires special agreement to be confirmed via confirmSpecialAgreement');
    }

    // Check for duplicate in SAP
    // (via our audit log: another approved credit entry for this invoice already has a document)
    const existing = await tx.run(
      SELECT.one.from(AuditLog).where({
        invoiceNumber,
        rule: { in: ['R3', 'R4', 'R5'] },
        approvalStatus: 'APPROVED',
        sapDocument: { '!=': null }
      })
    );
    if (existing && existing.ID !== auditLogID) {
      return req.reject(409, `Credit memo already exists: ${existing.sapDocument} for rule ${existing.rule}`);
    }

    const servicePath = '/sap/opu/odata/sap/API_CREDIT_MEMO_REQUEST_SRV';
    const orderReason = RULES[rule].orderReason;

    try {
      const { csrfToken, cookies } = await getCsrfTokenAndCookies(servicePath);

      // CHANGE 4: Set Cust. Reference to COMPLAINT-<invoice> only (removed rule and UUID suffix)
      // Same structure as the return payload, but document type YCR
      const payload = {
        CreditMemoRequestType: 'YCR',
        SalesOrganization: 'YSOD',
        DistributionChannel: 'Y1',
        OrganizationDivision: 'Y5',
        SoldToParty: soldToParty,
        SDDocumentReason: orderReason,
        PurchaseOrderByCustomer: `COMPLAINT-${invoiceNumber}`,
        HeaderBillingBlockReason: '08', // Billing block: Check Credit Memo
        to_Item: [{
          Material: material,
          RequestedQuantity: quantity,
          RequestedQuantityUnit: unit,
          ReferenceSDDocument: invoiceNumber,
          ReferenceSDDocumentItem: invoiceItem
        }]
      };

      console.log('createCreditMemoRequest payload:', JSON.stringify(payload, null, 2));

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

      const creditDoc = unwrap(response.data);

      // Update audit log with SAP document number
      // R5 additionally flags the entry for the warehouse to confirm the shortage
      await tx.run(
        UPDATE(AuditLog)
          .set({
            sapDocument: creditDoc.CreditMemoRequest,
            sapDocumentType: 'YCR',
            sapDocumentVersion: getEtag(response, creditDoc),
            warehouseCheckNeeded: rule === 'R5'
          })
          .where({ ID: auditLogID })
      );

      // Every field returned here must also be declared in CreditMemoResult (CDS)
      return {
        CreditMemoRequest: creditDoc.CreditMemoRequest,
        SalesDocumentType: creditDoc.CreditMemoRequestType || creditDoc.SalesDocumentType,
        SoldToParty: creditDoc.SoldToParty,
        SDDocumentReason: creditDoc.SDDocumentReason,
        TotalNetAmount: creditDoc.TotalNetAmount,
        TransactionCurrency: creditDoc.TransactionCurrency,
        OverallSDProcessStatus: creditDoc.OverallSDProcessStatus,
        sapDocumentVersion: getEtag(response, creditDoc)
      };
    } catch (err) {
      return handleError(req, err, 'createCreditMemoRequest');
    }
  });

  // ---- findInvoices: R9 - search for invoices when not named ----
  // Customer + date range are filtered in SAP; the material filter is applied
  // here on the items, and invoices without a matching item are dropped.
  srv.on('findInvoices', async (req) => {
    const { soldToParty, material, fromDate, toDate } = req.data;
    // Strict formats, because the values go into the OData $filter
    const idOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
    const dateOk = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

    if (!idOk(soldToParty) || !idOk(material) || !dateOk(fromDate) || !dateOk(toDate)) {
      return req.reject(400, 'soldToParty, material (ids) and fromDate, toDate (YYYY-MM-DD) are required');
    }
    try {
      // OData v2 date literal syntax: datetime'YYYY-MM-DDT00:00:00'
      const filter =
        `SoldToParty eq '${soldToParty}' and ` +
        `BillingDocumentDate ge datetime'${fromDate}T00:00:00' and ` +
        `BillingDocumentDate le datetime'${toDate}T00:00:00'`;
      const response = await callDestination(
        'GET',
        `/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV/A_BillingDocument?$filter=${encodeURIComponent(filter)}&$expand=to_Item&$format=json`
      );
      const invoices = (unwrap(response.data).results || [])
        // Keep only the items for the material in question...
        .map((doc) => ({
          ...doc,
          to_Item: { results: (doc.to_Item?.results || []).filter((i) => i.Material === material) }
        }))
        // ...and only invoices that still have such an item
        .filter((doc) => doc.to_Item.results.length > 0);
      return { soldToParty, material, fromDate, toDate, invoices };
    } catch (err) {
      return handleError(req, err, 'findInvoices');
    }
  });

  // ---- getAgreedPrice: R4 - check PR00 condition to detect price overcharge ----
  // Reads the PR00 (base price) condition record valid today for this customer,
  // material, sales organisation and distribution channel.
  srv.on('getAgreedPrice', async (req) => {
    const { soldToParty, material, salesOrganization, distributionChannel } = req.data;
    const idOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);

    if (!idOk(soldToParty) || !idOk(material) || !idOk(salesOrganization) || !idOk(distributionChannel)) {
      return req.reject(400, 'soldToParty, material, salesOrganization, and distributionChannel (all IDs) are required');
    }

    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      // Valid today: start date <= today <= end date
      const filter =
        `SoldToParty eq '${soldToParty}' and ` +
        `Material eq '${material}' and ` +
        `SalesOrganization eq '${salesOrganization}' and ` +
        `DistributionChannel eq '${distributionChannel}' and ` +
        `ConditionType eq 'PR00' and ` +
        `ConditionValidityStartDate le datetime'${today}T00:00:00' and ` +
        `ConditionValidityEndDate ge datetime'${today}T00:00:00'`;

      // The validity entity holds the dates; the price itself is in the
      // expanded condition record (to_SlsPrcgConditionRecord)
      const response = await callDestination(
        'GET',
        `/sap/opu/odata/sap/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgCndnRecdValidity?$filter=${encodeURIComponent(filter)}&$expand=to_SlsPrcgConditionRecord&$format=json`
      );

      const records = unwrap(response.data).results || [];
      return {
        soldToParty,
        material,
        salesOrganization,
        distributionChannel,
        today,
        // Flatten: lift the price out of the nested condition record
        agreedPrices: records.map((r) => ({
          ConditionRecord: r.ConditionRecord,
          ConditionType: r.ConditionType,
          ConditionRateValue: r.to_SlsPrcgConditionRecord?.ConditionRateValue,
          ConditionValidityStartDate: r.ConditionValidityStartDate,
          ConditionValidityEndDate: r.ConditionValidityEndDate
        }))
      };
    } catch (err) {
      return handleError(req, err, 'getAgreedPrice');
    }
  });

  // ---- getReturnStatus: check if goods were received (for audit trail) ----
  // CHANGE 3: Implemented for step 5.1.3 - reports when goods are received (GoodsMovementStatus = C)
  // Note: in the post-deploy test on DS4 the return header did not contain
  // GoodsMovementStatus (result 'UNKNOWN'); to be verified after a goods receipt.
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
      const received = returnData.GoodsMovementStatus === 'C';   // C = completely processed

      console.log(`getReturnStatus for ${returnDocumentNumber}: GoodsMovementStatus=${returnData.GoodsMovementStatus}, received=${received}`);

      return {
        returnDocumentNumber,
        // The API calls the field OverallSDProcessStatus; older name kept as fallback
        overallProcessingStatus: returnData.OverallSDProcessStatus ?? returnData.OverallProcessingStatus,
        goodsMovementStatus: returnData.GoodsMovementStatus || 'UNKNOWN',
        received
      };
    } catch (err) {
      return handleError(req, err, 'getReturnStatus');
    }
  });

  // ---- releaseCreditMemoRequest: remove billing block 08 after approval ----
  // PATCH with If-Match: SAP only applies the change if the ETag is current.
  srv.on('releaseCreditMemoRequest', async (req) => {
    const { creditMemoNumber } = req.data;
    if (!isDocNumber(creditMemoNumber)) {
      return req.reject(400, 'creditMemoNumber must be 1–10 letters or digits');
    }
    const servicePath = '/sap/opu/odata/sap/API_CREDIT_MEMO_REQUEST_SRV';
    try {
      // Use the caller's ETag if given, otherwise read the current one from SAP
      const versionStamp = req.data.versionStamp ||
        await fetchCurrentEtag(`${servicePath}/A_CreditMemoRequest('${creditMemoNumber}')`);
      const { csrfToken, cookies } = await getCsrfTokenAndCookies(servicePath);
      const payload = {
        HeaderBillingBlockReason: '' // Remove block 08
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
      // SAP answers a successful PATCH with 204 No Content
      return {
        creditMemoNumber,
        status: 'RELEASED'
      };
    } catch (err) {
      // 412 Precondition Failed = the document changed since the ETag was read
      return handleError(req, err, 'releaseCreditMemoRequest');
    }
  });

  // ---- releaseCustomerReturn: remove billing block 08 after approval ----
  // Same mechanism as releaseCreditMemoRequest, for customer returns
  srv.on('releaseCustomerReturn', async (req) => {
    const { returnDocumentNumber } = req.data;
    if (!isDocNumber(returnDocumentNumber)) {
      return req.reject(400, 'returnDocumentNumber must be 1–10 letters or digits');
    }
    const servicePath = '/sap/opu/odata/sap/API_CUSTOMER_RETURN_SRV';
    try {
      // Use the caller's ETag if given, otherwise read the current one from SAP
      const versionStamp = req.data.versionStamp ||
        await fetchCurrentEtag(`${servicePath}/A_CustomerReturn('${returnDocumentNumber}')`);
      const { csrfToken, cookies } = await getCsrfTokenAndCookies(servicePath);
      const payload = {
        HeaderBillingBlockReason: '' // Remove block 08
      };
      const response = await callDestination(
        'PATCH',
        `${servicePath}/A_CustomerReturn('${returnDocumentNumber}')`,
        payload,
        {
          'x-csrf-token': csrfToken,
          'Cookie': cookies,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'If-Match': versionStamp
        }
      );
      return {
        returnDocumentNumber,
        status: 'RELEASED'
      };
    } catch (err) {
      return handleError(req, err, 'releaseCustomerReturn');
    }
  });
};
