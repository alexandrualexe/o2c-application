// =============================================================================
// ReturnsService: the public API of the O2C Returns Agent
// -----------------------------------------------------------------------------
// Served as OData v4 at /odata/v4/returns. It is called by:
//   - the AI agent / front end (step by step, one action per decision),
//   - the email listener (srv/email-listener.js), in-process.
//
// Implementation: srv/returns-services.js (same base name, so CAP links them).
//
// Typical flow for one complaint:
//   getInvoice / findInvoices      -> identify the invoice
//   proposeAction                  -> rule R1–R9, proposed action, credit value
//   logRequest                     -> audit entry (PENDING)
//   setApprovalStatus              -> APPROVED / REJECTED by the right role
//   confirmSpecialAgreement        -> R4 only
//   createReturn / createCreditMemoRequest -> SAP document (billing block 08)
//   releaseCustomerReturn / releaseCreditMemoRequest -> remove billing block
//   getReturnStatus                -> has the warehouse received the goods?
//
// Note on types: SAP OData v2 sends amounts and quantities as strings, so the
// SAP-shaped types below use String and pass the values through unchanged.
// =============================================================================

using o2c from '../db/schema';

service ReturnsService {
  // Read-only view of the audit trail (GET /odata/v4/returns/AuditLog).
  // Rows are only written through the actions below, never directly.
  @readonly entity AuditLog as projection on o2c.ReturnAuditLog;

  // ---------- Shared types ----------
  // These mirror the fields we use from the SAP APIs. Fields that are not
  // declared here are dropped from the OData response, so a new field that
  // should reach the client has to be added both here and in the handler.

  // One line of an SAP billing document (API_BILLING_DOCUMENT_SRV)
  type InvoiceItem {
    BillingDocument      : String;
    BillingDocumentItem  : String;   // e.g. '10'
    Material             : String;
    BillingQuantity      : String;
    BillingQuantityUnit  : String;
    NetAmount            : String;
    TransactionCurrency  : String;
  };

  // SAP billing document header plus its items ($expand=to_Item)
  type Invoice {
    BillingDocument      : String;
    BillingDocumentType  : String;
    BillingDocumentDate  : String;
    SoldToParty          : String;
    SalesOrganization    : String;
    DistributionChannel  : String;
    TotalNetAmount       : String;
    TransactionCurrency  : String;
    to_Item              : { results : many InvoiceItem; };   // OData v2 collection shape
  };

  // Item of an existing customer return that references the invoice (R8 check)
  type ReturnItem {
    CustomerReturn          : String;
    CustomerReturnItem      : String;
    Material                : String;
    RequestedQuantity       : String;
    RequestedQuantityUnit   : String;
    ReferenceSDDocument     : String;   // = the invoice number
    ReferenceSDDocumentItem : String;
  };

  // Existing credit memo request that references the invoice (R8 check)
  type CreditMemoRequestHeader {
    CreditMemoRequest       : String;
    SalesOrganization       : String;
    SoldToParty             : String;
    SDDocumentReason        : String;
    TotalNetAmount          : String;
    TransactionCurrency     : String;
    ReferenceSDDocument     : String;
    OverallSDProcessStatus  : String;
    sapDocumentVersion      : String;
  };

  // Result of checkExistingCredits: anything already in SAP for this invoice
  type ExistingCreditsResult {
    existingReturns : many ReturnItem;
    existingCredits : many CreditMemoRequestHeader;
  };

  // Result of findInvoices (R9: the customer did not name the invoice)
  type FindInvoicesResult {
    soldToParty : String;
    material    : String;
    fromDate    : String;
    toDate      : String;
    invoices    : many Invoice;   // Only invoices that contain the material
  };

  // One PR00 (base price) condition record valid today
  type AgreedPrice {
    ConditionRecord            : String;
    ConditionType              : String;   // 'PR00'
    ConditionRateValue         : String;   // Agreed price per unit
    ConditionValidityStartDate : String;
    ConditionValidityEndDate   : String;
  };

  // Result of getAgreedPrice (R4: price higher than agreed)
  type AgreedPriceResult {
    soldToParty         : String;
    material            : String;
    salesOrganization   : String;
    distributionChannel : String;
    today               : String;     // Date used for the validity filter
    agreedPrices        : many AgreedPrice;
  };

  // Result of getReturnStatus: has the warehouse received the returned goods?
  type ReturnStatusResult {
    returnDocumentNumber    : String;
    overallProcessingStatus : String;   // SAP OverallSDProcessStatus (A = open, B = in process, C = completed)
    returnsDelivery         : String;   // Returns delivery (or deliveries, comma-separated) for the return
    goodsMovementStatus     : String;   // From the returns delivery items: A not received, B partly, C received;
                                        // 'NO_DELIVERY' when there is no returns delivery yet
    received                : Boolean;  // true when goodsMovementStatus = 'C'
  };

  // Result of createReturn (SAP customer return, type YRE)
  type CreateReturnResult {
    CustomerReturn          : String;   // New SAP document number (e.g. 60000164)
    CustomerReturnType      : String;   // 'YRE'
    SoldToParty             : String;
    SDDocumentReason        : String;   // Order reason derived from the rule
    TotalNetAmount          : String;
    TransactionCurrency     : String;
    OverallSDProcessStatus  : String;
    sapDocumentVersion      : String;   // ETag, needed for later PATCH (release)
  };

  // Result of createCreditMemoRequest (SAP credit memo request, type YCR)
  type CreditMemoResult {
    CreditMemoRequest       : String;   // New SAP document number
    SalesDocumentType       : String;   // 'YCR'
    SoldToParty             : String;
    SDDocumentReason        : String;
    TotalNetAmount          : String;
    TransactionCurrency     : String;
    OverallSDProcessStatus  : String;
    sapDocumentVersion      : String;   // ETag, needed for later PATCH (release)
  };

  type ReleaseCreditMemoResult {
    creditMemoNumber : String;
    status           : String;   // 'RELEASED'
  };

  type ReleaseReturnResult {
    returnDocumentNumber : String;
    status               : String;   // 'RELEASED'
  };

  // Result of proposeAction: the decision the agent presents for approval
  type ProposalResult {
    rule             : String;    // 'R1'..'R9'
    proposedAction   : String;    // RETURN / CREDIT / REPLACEMENT / REJECT / PENDING
    reasoning        : String;    // Human-readable explanation
    creditValue      : Decimal;   // Proposed credit amount (EUR)
    requiresApproval : Boolean;
    requiredApprover : String;    // Minimum role that may approve
  };

  type PriceCheckResult {
    invoicedPrice  : Decimal;
    agreedPrice    : Decimal;
    overcharged    : Boolean;
    creditAmount   : Decimal;     // (invoiced - agreed) * quantity, 0 if not overcharged
  };

  // ---------- Audit log ----------
  // Actions (POST) that change the audit trail in our own database.

  // Create a PENDING audit entry for a proposal; computes requiredApprover
  action logRequest(
    invoiceNumber: String,
    proposedAction: String,
    rule: String,
    reason: String,
    claimedQuantity: Decimal,
    claimedAmount: Decimal,
    creditValue: Decimal,
    evidenceUrl: String
  ) returns AuditLog;

  // Approve or reject a PENDING entry. The approver role must be at least the
  // required tier; approving is blocked (409) if SAP already has a document.
  action setApprovalStatus(
    ID: UUID,
    status: String,         // 'APPROVED' or 'REJECTED'
    approvedBy: String,     // User ID of the decision maker
    approverRole: String    // customer-service-lead / credit-manager / finance-director
  ) returns AuditLog;

  // R4 only: confirm the special price agreement before a credit memo can be created
  action confirmSpecialAgreement(
    ID: UUID
  ) returns AuditLog;

  // ---------- Read ----------
  // Functions (GET) with no side effects; they read from SAP or just calculate.

  // Billing document with items
  function getInvoice(invoiceNumber: String) returns Invoice;
  // Returns / credit memo requests in SAP that already reference the invoice (R8)
  function checkExistingCredits(invoiceNumber: String) returns ExistingCreditsResult;
  // Search invoices by customer, material and date range (YYYY-MM-DD) for R9
  function findInvoices(soldToParty: String, material: String, fromDate: String, toDate: String) returns FindInvoicesResult;
  // Agreed PR00 price valid today (R4)
  function getAgreedPrice(soldToParty: String, material: String, salesOrganization: String, distributionChannel: String) returns AgreedPriceResult;
  // Goods receipt status of a customer return
  function getReturnStatus(returnDocumentNumber: String) returns ReturnStatusResult;
  // The R1–R9 decision tree (see returns-services.js for rule precedence)
  function proposeAction(invoiceNumber: String, invoiceItem: String, material: String, quantity: Decimal, claimedAmount: Decimal, reason: String, soldToParty: String) returns ProposalResult;
  // Pure calculation helper for price disputes
  function checkPrice(invoicedPrice: Decimal, agreedPrice: Decimal, quantity: Decimal) returns PriceCheckResult;

  // ---------- Control Tower (read-only) ----------
  // Functions (GET) for the Reclaim Control Tower, implemented in
  // srv/control-tower.js. Each returns a JSON string
  //   { underlyingRequests: [...SAP GETs], capturedOn: 'YYYY-MM-DD', response: {...} }
  // so the OData answer is { "value": "<json>" }. Deliberately no actions here:
  // the Control Tower has no write path.

  // Goods issued but not (fully) billed; top 1..500 (default 500)
  function listUnbilledDeliveries(top: Integer, soldToParty: String) returns LargeString;
  // Goods issued more than 3 days ago without proof of delivery
  function listDeliveriesAwaitingPod(top: Integer, shipToParty: String) returns LargeString;
  // Sales orders with billing block, delivery block or credit block
  function listBlockedOrders(top: Integer) returns LargeString;
  // Overdue open items per customer for one company code; keyDate YYYY-MM-DD (default today)
  function listOverdueReceivables(companyCode: String, keyDate: String) returns LargeString;
  // Billing due list for one customer; top default 100
  function listBillingDueList(soldToParty: String, top: Integer) returns LargeString;
  // Country, city and name for comma-separated business partners, plus all Norway addresses
  function getCustomerAddresses(partners: String) returns LargeString;
  // Sales order -> delivery -> billing conformance check
  function checkOrderConformance(salesOrder: String) returns LargeString;
  // Customer returns older than 7 days without a credit memo (5.2.1); top 1..500 (default 500)
  function listReturnsWithoutCredit(top: Integer, soldToParty: String) returns LargeString;

  // ---------- Write ----------
  // Actions that create or change documents in SAP. Each one requires an
  // APPROVED audit entry that matches the request (invoice, rule, action).

  // R1/R2: customer return (YRE) with billing block 08
  action createReturn(
    auditLogID: UUID,
    invoiceNumber: String,
    invoiceItem: String,
    material: String,
    quantity: String,
    unit: String,
    rule: String,
    soldToParty: String,
    creditValue: Decimal
  ) returns CreateReturnResult;

  // R3/R4/R5: credit memo request (YCR) with billing block 08
  action createCreditMemoRequest(
    auditLogID: UUID,
    invoiceNumber: String,
    invoiceItem: String,
    material: String,
    quantity: String,
    unit: String,
    rule: String,
    soldToParty: String,
    creditValue: Decimal,
    evidenceUrl: String     // Required for R3 (photo) and R5 (proof of delivery)
  ) returns CreditMemoResult;

  // Remove billing block 08. versionStamp (ETag) is optional: if omitted, the
  // current ETag is read from SAP first.
  action releaseCreditMemoRequest(creditMemoNumber: String, versionStamp: String) returns ReleaseCreditMemoResult;
  action releaseCustomerReturn(returnDocumentNumber: String, versionStamp: String) returns ReleaseReturnResult;
}
