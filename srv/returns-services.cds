service ReturnsService {
  function getInvoice(invoiceNumber: String) returns String;
  function checkExistingCredits(invoiceNumber: String) returns String;
  action createReturn(invoiceNumber: String, invoiceItem: String, material: String, quantity: String, unit: String, reason: String, soldToParty: String) returns String;
  action createCreditMemoRequest(invoiceNumber: String, material: String, quantity: String, unit: String, reason: String, soldToParty: String) returns String;
}
