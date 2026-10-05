namespace o2c;
using { cuid, managed } from '@sap/cds/common';

// ID (from cuid) = request ID
// createdAt / modifiedAt (from managed) = timestamps
entity ReturnAuditLog : cuid, managed {
  invoiceNumber  : String(10) not null;
  proposedAction : String(20) not null;   // RETURN | CREDIT | REPLACEMENT | REJECT
  approvalStatus : String(20) default 'PENDING'; // PENDING | APPROVED | REJECTED
  decidedAt      : Timestamp;
  sapDocument    : String(10);            // DS4 document number, once created
}