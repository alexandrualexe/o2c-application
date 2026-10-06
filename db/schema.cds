// =============================================================================
// Data model for the O2C Returns Agent
// -----------------------------------------------------------------------------
// The app keeps very little data of its own. Invoices, returns and credit memos
// live in SAP S/4HANA (destination DS4) and are read or created through OData.
// What is stored here is the audit trail: every complaint that was assessed,
// which rule (R1–R9) was applied, who approved it, and which SAP document came
// out of it.
//
// Locally the tables live in SQLite (in memory); on BTP they are deployed to the
// HANA HDI container "o2c-returns-hdi" by the db-deployer module (see mta.yaml).
// =============================================================================

namespace o2c;

// cuid    -> adds a UUID primary key "ID"
// managed -> adds createdAt / createdBy / modifiedAt / modifiedBy, filled by CAP
using { cuid, managed } from '@sap/cds/common';

// -----------------------------------------------------------------------------
// ReturnAuditLog: one row per complaint (customer return / credit request).
//
// Lifecycle of a row:
//   1. logRequest           -> row created, approvalStatus = 'PENDING'
//   2. setApprovalStatus    -> 'APPROVED' or 'REJECTED' (role checked against
//                              requiredApprover, SAP re-checked for duplicates)
//   3. confirmSpecialAgreement (R4 only) -> agreementApproved = true
//   4. createReturn / createCreditMemoRequest -> sapDocument, sapDocumentType
//                              and sapDocumentVersion (ETag) are filled in
//
// Once sapDocument is set the row is "used": no second document can be created
// from the same approval.
// -----------------------------------------------------------------------------
entity ReturnAuditLog : cuid, managed {
  // --- What the complaint is about ---
  invoiceNumber         : String;    // SAP billing document (e.g. 90000376)
  invoiceItem           : String;    // Line item for R7 validation
  material              : String;

  // --- The decision proposed by proposeAction ---
  proposedAction        : String;    // 'RETURN', 'CREDIT', 'REPLACEMENT', 'REJECT', 'PENDING'
  rule                  : String;    // 'R1' to 'R9'
  reason                : String;    // User's description or reasoning

  // --- Claimed vs. invoiced figures (used for the R7 plausibility check) ---
  claimedQuantity       : Decimal;
  claimedAmount         : Decimal;
  invoicedQuantity      : Decimal;
  invoicedAmount        : Decimal;

  // --- Approval workflow ---
  approvalStatus        : String;    // 'PENDING', 'APPROVED', 'REJECTED'
  decidedAt             : Timestamp; // When the approval decision was made
  approvedBy            : String;    // User who approved/rejected
  approverRole          : String;    // Role of approver
  requiredApprover      : String;    // 'customer-service-lead', 'credit-manager', 'finance-director'

  // --- Money ---
  creditValue           : Decimal;   // Proposed credit; drives the approval tier for R1/R2
  creditCurrency        : String default 'EUR';

  // --- Resulting SAP document (filled after creation) ---
  sapDocument           : String;    // Return number (YRE) or Credit Memo number (YCR)
  sapDocumentType       : String;    // 'YRE' or 'YCR'
  sapDocumentVersion    : String;    // ETag/version stamp for PATCH operations

  // --- Rule-specific flags ---
  evidenceUrl           : String;    // Photo URL for R3, proof of delivery for R5
  warehouseCheckNeeded  : Boolean default false; // R5: flag for warehouse
  autoCreatedCreditMemo : String;    // Legacy: R1/R2 auto-credit status (DEPRECATED: use approval workflow)
  agreementApproved     : Boolean default false; // R4: special agreement confirmed by approver
}

// -----------------------------------------------------------------------------
// Reference data. Not used by the service logic today (customer and material
// data is read from SAP); kept for future local lookups / UI value helps.
// -----------------------------------------------------------------------------
entity Customer : cuid {
  soldToParty      : String;  // SAP customer number
  name             : String;
  email            : String;  // Could be matched against the email sender
}

entity Material : cuid {
  material         : String;  // SAP material number
  description      : String;
  unitPrice        : Decimal;
}
