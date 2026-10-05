using o2c from '../db/schema';

service ReturnsService {
  @readonly entity AuditLog as projection on o2c.ReturnAuditLog;

  action logRequest(invoiceNumber: String, proposedAction: String) returns AuditLog;
  action setApprovalStatus(ID: UUID, status: String) returns AuditLog;

  function getInvoice(invoiceNumber: String) returns LargeString;
  function checkExistingCredits(invoiceNumber: String) returns LargeString;
  function findInvoices(soldToParty: String, material: String, fromDate: String, toDate: String) returns LargeString;
  function getAgreedPrice(soldToParty: String, material: String, salesOrganization: String, distributionChannel: String) returns LargeString;
  function getReturnStatus(returnDocumentNumber: String) returns LargeString;
  
  action createReturn(invoiceNumber: String, invoiceItem: String, material: String, quantity: String, unit: String, reason: String, soldToParty: String) returns LargeString;
  action createCreditMemoRequest(invoiceNumber: String, material: String, quantity: String, unit: String, reason: String, soldToParty: String) returns LargeString;
  action releaseCreditMemoRequest(creditMemoNumber: String, versionStamp: String) returns LargeString;
}