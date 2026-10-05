namespace com.example.returns;

using { cuid, managed } from '@sap/cds/common';

entity AuditLog : cuid, managed {
  invoiceNumber: String;
  invoiceItem: String;
  material: String;
  proposedAction: String;
  rule: String;
  reason: String;
  claimedQuantity: Decimal;
  claimedAmount: Decimal;
  approvalStatus: String; // PENDING, APPROVED, REJECTED
  creditValue: Decimal;
  creditCurrency: String;
  requiredApprover: String;
  approvedBy: String;
  approverRole: String;
  decidedAt: DateTime;
  evidenceUrl: String;
  sapDocument: String;
  sapDocumentType: String; // YRE (return) or YCR (credit memo)
  sapDocumentVersion: String;
  warehouseCheckNeeded: Boolean;
  agreementApproved: Boolean;
}

type InvoiceResult {
  BillingDocument: String;
  BillingDocumentDate: DateTime;
  SoldToParty: String;
  SalesOrganization: String;
  DistributionChannel: String;
  to_Item: array of {
    BillingDocumentItem: String;
    Material: String;
    BillingQuantity: Decimal;
    BillingQuantityUnit: String;
    NetAmount: Decimal;
  };
}

type ProposalResult {
  rule: String;
  proposedAction: String;
  reasoning: String;
  creditValue: Decimal;
  requiresApproval: Boolean;
  requiredApprover: String;
}

type PriceCheckResult {
  invoicedPrice: Decimal;
  agreedPrice: Decimal;
  overcharged: Boolean;
  creditAmount: Decimal;
}

type ExistingCreditsResult {
  existingReturns: array of {
    CustomerReturn: String;
  };
  existingCredits: array of {
    CreditMemoRequest: String;
  };
}

type ReturnResult {
  CustomerReturn: String;
  SalesDocumentType: String;
  SoldToParty: String;
  SDDocumentReason: String;
  TotalNetAmount: String;
  TransactionCurrency: String;
  OverallSDProcessStatus: String;
  sapDocumentVersion: String;
}

type CreditMemoResult {
  CreditMemoRequest: String;
  SalesDocumentType: String;
  SoldToParty: String;
  SDDocumentReason: String;
  TotalNetAmount: String;
  TransactionCurrency: String;
  OverallSDProcessStatus: String;
  sapDocumentVersion: String;
}

type ReleaseCreditMemoResult {
  creditMemoNumber: String;
  status: String;
}

type ReleaseReturnResult {
  returnDocumentNumber: String;
  status: String;
}

type FindInvoicesResult {
  soldToParty: String;
  material: String;
  fromDate: String;
  toDate: String;
  invoices: array of InvoiceResult;
}

type AgreedPriceResult {
  soldToParty: String;
  material: String;
  salesOrganization: String;
  distributionChannel: String;
  today: String;
  agreedPrices: array of {
    ConditionRecord: String;
    ConditionType: String;
    ConditionRateValue: Decimal;
    ConditionValidityStartDate: DateTime;
    ConditionValidityEndDate: DateTime;
  };
}

type ReturnStatusResult {
  returnDocumentNumber: String;
  overallProcessingStatus: String;
  goodsMovementStatus: String;
  received: Boolean;
}

service ReturnsService {
  entity AuditLog as projection on db.AuditLog;

  function proposeAction(
    invoiceNumber: String,
    invoiceItem: String,
    material: String,
    quantity: Decimal,
    claimedAmount: Decimal,
    reason: String,
    soldToParty: String
  ) returns ProposalResult;

  function checkPrice(
    invoicedPrice: Decimal,
    agreedPrice: Decimal,
    quantity: Decimal
  ) returns PriceCheckResult;

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

  function getInvoice(invoiceNumber: String) returns InvoiceResult;

  function checkExistingCredits(invoiceNumber: String) returns ExistingCreditsResult;

  action createReturn(
    auditLogID: UUID,
    invoiceNumber: String,
    invoiceItem: String,
    material: String,
    quantity: Decimal,
    unit: String,
    rule: String,
    soldToParty: String,
    creditValue: Decimal
  ) returns ReturnResult;

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

  function findInvoices(
    soldToParty: String,
    material: String,
    fromDate: String,
    toDate: String
  ) returns FindInvoicesResult;

  function getAgreedPrice(
    soldToParty: String,
    material: String,
    salesOrganization: String,
    distributionChannel: String
  ) returns AgreedPriceResult;

  function getReturnStatus(returnDocumentNumber: String) returns ReturnStatusResult;

  action releaseCreditMemoRequest(
    creditMemoNumber: String,
    versionStamp: String
  ) returns ReleaseCreditMemoResult;

  action releaseCustomerReturn(
    returnDocumentNumber: String,
    versionStamp: String
  ) returns ReleaseReturnResult;
}