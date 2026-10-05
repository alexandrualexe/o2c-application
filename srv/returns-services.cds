using o2c from '../db/schema';

service ReturnsService {
  @readonly entity AuditLog as projection on o2c.ReturnAuditLog;

  // ---------- Shared types ----------
  type InvoiceItem {
    BillingDocument      : String;
    BillingDocumentItem  : String;
    Material             : String;
    BillingQuantity      : String;
    BillingQuantityUnit  : String;
    NetAmount            : String;
    TransactionCurrency  : String;
  };

  type Invoice {
    BillingDocument      : String;
    BillingDocumentType  : String;
    BillingDocumentDate  : String;
    SoldToParty          : String;
    SalesOrganization    : String;
    DistributionChannel  : String;
    TotalNetAmount       : String;
    TransactionCurrency  : String;
    to_Item              : { results : many InvoiceItem; };
  };

  type ReturnItem {
    CustomerReturn          : String;
    CustomerReturnItem      : String;
    Material                : String;
    RequestedQuantity       : String;
    RequestedQuantityUnit   : String;
    ReferenceSDDocument     : String;
    ReferenceSDDocumentItem : String;
  };

  type CreditMemoRequestHeader {
    CreditMemoRequest       : String;
    SalesOrganization       : String;
    SoldToParty             : String;
    SDDocumentReason        : String;
    TotalNetAmount          : String;
    TransactionCurrency     : String;
    ReferenceSDDocument     : String;
    OverallSDProcessStatus  : String;
  };

  type ExistingCreditsResult {
    existingReturns : many ReturnItem;
    existingCredits : many CreditMemoRequestHeader;
  };

  type FindInvoicesResult {
    soldToParty : String;
    material    : String;
    fromDate    : String;
    toDate      : String;
    invoices    : many Invoice;
  };

  type AgreedPrice {
    ConditionRecord            : String;
    ConditionType              : String;
    ConditionRateValue         : String;
    ConditionValidityStartDate : String;
    ConditionValidityEndDate   : String;
  };

  type AgreedPriceResult {
    soldToParty         : String;
    material            : String;
    salesOrganization   : String;
    distributionChannel : String;
    today               : String;
    agreedPrices        : many AgreedPrice;
  };

  type ReturnStatusResult {
    returnDocumentNumber    : String;
    overallProcessingStatus : String;
    warehouseReceiptStatus  : String;
    received                : Boolean;
  };

  type CreateReturnResult {
    CustomerReturn          : String;
    CustomerReturnType      : String;
    SoldToParty             : String;
    SDDocumentReason        : String;
    OverallSDProcessStatus  : String;
  };

  type CreditMemoResult {
    CreditMemoRequest       : String;
    SalesDocumentType       : String;
    SoldToParty             : String;
    SDDocumentReason        : String;
    TotalNetAmount          : String;
    TransactionCurrency     : String;
    OverallSDProcessStatus  : String;
  };

  type ReleaseCreditMemoResult {
    creditMemoNumber : String;
    status           : String;
  };

  type ReleaseReturnResult {
    returnDocumentNumber : String;
    status               : String;
  };

  type ProposalResult {
    rule             : String;
    proposedAction   : String;
    reasoning        : String;
    creditValue      : Decimal;
    requiresApproval : Boolean;
    requiredApprover : String;
  };

  type PriceCheckResult {
    invoicedPrice  : Decimal;
    agreedPrice    : Decimal;
    overcharged    : Boolean;
    creditAmount   : Decimal;
  };

  // ---------- Audit log ----------
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

  action setApprovalStatus(
    ID: UUID, 
    status: String,
    approvedBy: String,
    approverRole: String
  ) returns AuditLog;

  action confirmSpecialAgreement(
    ID: UUID
  ) returns AuditLog;

  // ---------- Read ----------
  function getInvoice(invoiceNumber: String) returns Invoice;
  function checkExistingCredits(invoiceNumber: String) returns ExistingCreditsResult;
  function findInvoices(soldToParty: String, material: String, fromDate: String, toDate: String) returns FindInvoicesResult;
  function getAgreedPrice(soldToParty: String, material: String, salesOrganization: String, distributionChannel: String) returns AgreedPriceResult;
  function getReturnStatus(returnDocumentNumber: String) returns ReturnStatusResult;
  function proposeAction(invoiceNumber: String, invoiceItem: String, material: String, quantity: Decimal, claimedAmount: Decimal, reason: String, soldToParty: String) returns ProposalResult;
  function checkPrice(invoicedPrice: Decimal, agreedPrice: Decimal, quantity: Decimal) returns PriceCheckResult;

  // ---------- Write ----------
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

  action createCreditMemoRequest(
    auditLogID: UUID,
    invoiceNumber: String, 
    material: String, 
    quantity: String, 
    unit: String, 
    rule: String,
    soldToParty: String,
    creditValue: Decimal,
    evidenceUrl: String
  ) returns CreditMemoResult;

  action releaseCreditMemoRequest(creditMemoNumber: String, versionStamp: String) returns ReleaseCreditMemoResult;
  action releaseCustomerReturn(returnDocumentNumber: String, versionStamp: String) returns ReleaseReturnResult;
}