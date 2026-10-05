const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const DEST = 'DS4';
const SAP_CLIENT = '100';

// Rule definitions with all metadata
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

// Generic request helper
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
      ? setCookie.map((c) => c.split(';')[0]).join('; ')
      : ''
  };
}

// Convert backend errors into proper CAP errors
function handleError(req, err, context) {
  const status = err.response?.status;
  const backendMsg =
    err.response?.data?.error?.message?.value ||
    err.response?.data?.error?.message ||
    err.message;
  console.error(`${context} failed:`, status, backendMsg);
  return req.reject(status || 500, `${context} failed: ${backendMsg}`);
}

// SAP OData v2 returns { d: ... }
const unwrap = (data) => (data && data.d !== undefined ? data.d : data);

module.exports = function (srv) {
  const { AuditLog } = srv.entities;

  // ---- proposeAction: R1-R9 decision tree ----
  srv.on('proposeAction', async (req) => {
    const { invoiceNumber, invoiceItem, material, quantity, claimedAmount, reason, soldToParty } = req.data;

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
      try {
        const existingCreds = await tx.send('checkExistingCredits', { invoiceNumber });
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
        console.warn('checkExistingCredits failed (non-fatal):', err.message);
      }

      // Normalize reason to lowercase for keyword matching
      const lowerReason = (reason || '').toLowerCase();

      // ---- RULE PRECEDENCE ----
      // R3 must come BEFORE R1 because "damaged and leaking" should be R3, not R1

      // R3: Irrecoverable goods (ruined, leaking, contaminated)
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
      if (lowerReason.includes('price') || lowerReason.includes('expensive') || lowerReason.includes('overcharg')) {
        // Query agreed price from SAP PR00 condition
        let agreedPrice = invoicedPrice; // Default to invoiced price
        try {
          const priceResult = await tx.send('getAgreedPrice', {
            soldToParty: soldToParty || '',
            material: material || '',
            salesOrganization: invoice.SalesOrganization,
            distributionChannel: invoice.DistributionChannel
          });
          
          if (priceResult.agreedPrices?.length > 0) {
            agreedPrice = parseFloat(priceResult.agreedPrices[0].ConditionRateValue) || invoicedPrice;
          }
        } catch (err) {
          console.warn('getAgreedPrice failed:', err.message);
        }

        // Detect overcharge
        if (invoicedPrice > agreedPrice) {
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
      return {
        rule: 'R9',
        proposedAction: 'PENDING',
        reasoning: `Reason unclear: "${reason}". Please clarify: damaged/defective (R1/R2), ruined (R3), price issue (R4), short delivery (R5), or replacement (R6)?`,
        creditValue: 0,
        requiresApproval: false,
        requiredApprover: null
      };
    } catch (err) {
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
    const tx = cds.tx(req);
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

    return tx.run(SELECT.one.from(AuditLog).where({ ID }));
  });

  // ---- setApprovalStatus: decide a pending request ----
  srv.on('setApprovalStatus', async (req) => {
    const { ID, status, approvedBy, approverRole } = req.data;

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
    const allowedRoles = {
      'customer-service-lead': ['customer-service-lead', 'credit-manager', 'finance-director'],
      'credit-manager': ['credit-manager', 'finance-director'],
      'finance-director': ['finance-director']
    };

    const required = auditLog.requiredApprover;
    if (!allowedRoles[required] || !allowedRoles[required].includes(approverRole)) {
      return req.reject(403, `Role ${approverRole} cannot approve. Required: ${required}`);
    }

    // Update status
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

    if (!updated) {
      return req.reject(
        409,
        `Request ${ID} is already ${auditLog.approvalStatus}`
      );
    }

    return tx.run(SELECT.one.from(AuditLog).where({ ID }));
  });

  // ---- confirmSpecialAgreement: R4 - unlock credit after special agreement confirmed ----
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

  // ---- checkExistingCredits: R8 - check for duplicate complaints ----
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

  // ---- createReturn: R1, R2 - return goods and block for credit after receipt ----
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

    if (auditLog.sapDocument) {
      return req.reject(409, `Document already created: ${auditLog.sapDocumentType} ${auditLog.sapDocument}`);
    }

    // Check for duplicate in SAP
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

      const payload = {
        CustomerReturnType: 'YRE',
        SalesOrganization: 'YSOD',
        DistributionChannel: 'Y1',
        OrganizationDivision: 'Y5',
        SoldToParty: soldToParty,
        SDDocumentReason: orderReason,
        PurchaseOrderByCustomer: `COMPLAINT-${invoiceNumber}-${rule}-${auditLogID.substring(0, 8)}`,
        HeaderBillingBlockReason: '08', // Billing block: Check Credit Memo
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

      const returnDoc = unwrap(response.data);
      
      // Update audit log with SAP document number
      await tx.run(
        UPDATE(AuditLog)
          .set({
            sapDocument: returnDoc.CustomerReturn,
            sapDocumentType: 'YRE',
            sapDocumentVersion: returnDoc.__metadata?.version || returnDoc.version
          })
          .where({ ID: auditLogID })
      );

      return returnDoc;
    } catch (err) {
      return handleError(req, err, 'createReturn');
    }
  });

  // ---- createCreditMemoRequest: R3, R4, R5 - credit without or before goods return ----
  srv.on('createCreditMemoRequest', async (req) => {
    const {
      auditLogID,
      invoiceNumber,
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

    if (auditLog.sapDocument) {
      return req.reject(409, `Document already created: ${auditLog.sapDocumentType} ${auditLog.sapDocument}`);
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

      const payload = {
        SalesDocumentType: 'YCR',
        SalesOrganization: 'YSOD',
        DistributionChannel: 'Y1',
        OrganizationDivision: 'Y5',
        SoldToParty: soldToParty,
        SDDocumentReason: orderReason,
        PurchaseOrderByCustomer: `COMPLAINT-${invoiceNumber}-${rule}-${auditLogID.substring(0, 8)}`,
        HeaderBillingBlockReason: '08', // Billing block: Check Credit Memo
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

      const creditDoc = unwrap(response.data);
      
      // Update audit log with SAP document number
      await tx.run(
        UPDATE(AuditLog)
          .set({
            sapDocument: creditDoc.CreditMemoRequest,
            sapDocumentType: 'YCR',
            sapDocumentVersion: creditDoc.__metadata?.version || creditDoc.version,
            warehouseCheckNeeded: rule === 'R5'
          })
          .where({ ID: auditLogID })
      );

      return creditDoc;
    } catch (err) {
      return handleError(req, err, 'createCreditMemoRequest');
    }
  });

  // ---- findInvoices: R9 - search for invoices when not named ----
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
      return { soldToParty, material, fromDate, toDate, invoices };
    } catch (err) {
      return handleError(req, err, 'findInvoices');
    }
  });

  // ---- getAgreedPrice: R4 - check PR00 condition to detect price overcharge ----
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
      return {
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
      };
    } catch (err) {
      return handleError(req, err, 'getAgreedPrice');
    }
  });

  // ---- getReturnStatus: check if goods were received (for audit trail) ----
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
      const received = returnData.WarehouseReceiptStatus === 'C';

      return {
        returnDocumentNumber,
        overallProcessingStatus: returnData.OverallProcessingStatus,
        warehouseReceiptStatus: returnData.WarehouseReceiptStatus || 'UNKNOWN',
        received
      };
    } catch (err) {
      return handleError(req, err, 'getReturnStatus');
    }
  });

  // ---- releaseCreditMemoRequest: remove billing block 08 after approval ----
  srv.on('releaseCreditMemoRequest', async (req) => {
    const { creditMemoNumber, versionStamp } = req.data;
    if (!creditMemoNumber || !versionStamp) {
      return req.reject(400, 'creditMemoNumber and versionStamp are required');
    }
    const servicePath = '/sap/opu/odata/sap/API_CREDIT_MEMO_REQUEST_SRV';
    try {
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
      return {
        creditMemoNumber,
        status: 'RELEASED'
      };
    } catch (err) {
      return handleError(req, err, 'releaseCreditMemoRequest');
    }
  });

  // ---- releaseCustomerReturn: remove billing block 08 after approval ----
  srv.on('releaseCustomerReturn', async (req) => {
    const { returnDocumentNumber, versionStamp } = req.data;
    if (!returnDocumentNumber || !versionStamp) {
      return req.reject(400, 'returnDocumentNumber and versionStamp are required');
    }
    const servicePath = '/sap/opu/odata/sap/API_CUSTOMER_RETURN_SRV';
    try {
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