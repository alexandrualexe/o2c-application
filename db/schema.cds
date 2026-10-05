namespace o2c;

using { cuid, managed } from '@sap/cds/common';

entity ReturnAuditLog : cuid, managed {
  invoiceNumber         : String;
  invoiceItem           : String;    // Line item for R7 validation
  material              : String;
  proposedAction        : String;    // 'RETURN', 'CREDIT', 'REPLACEMENT', 'REJECT', 'PENDING'
  rule                  : String;    // 'R1' to 'R9'
  reason                : String;    // User's description or reasoning
  claimedQuantity       : Decimal;
  claimedAmount         : Decimal;
  invoicedQuantity      : Decimal;
  invoicedAmount        : Decimal;
  approvalStatus        : String;    // 'PENDING', 'APPROVED', 'REJECTED'
  decidedAt             : Timestamp;
  approvedBy            : String;    // User who approved/rejected
  approverRole          : String;    // Role of approver
  requiredApprover      : String;    // 'customer-service-lead', 'credit-manager', 'finance-director'
  creditValue           : Decimal;
  creditCurrency        : String default 'EUR';
  sapDocument           : String;    // Return number (YRE) or Credit Memo number (YCR)
  sapDocumentType       : String;    // 'YRE' or 'YCR'
  sapDocumentVersion    : String;    // ETag/version stamp for PATCH operations
  evidenceUrl           : String;    // Photo URL for R3, proof of delivery for R5
  warehouseCheckNeeded  : Boolean default false; // R5: flag for warehouse
  autoCreatedCreditMemo : String;    // Legacy: R1/R2 auto-credit status (DEPRECATED: use approval workflow)
  agreementApproved     : Boolean default false; // R4: special agreement confirmed by approver
}

entity Customer : cuid {
  soldToParty      : String;
  name             : String;
  email            : String;
}

entity Material : cuid {
  material         : String;
  description      : String;
  unitPrice        : Decimal;
}