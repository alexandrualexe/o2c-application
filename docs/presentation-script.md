# O2C Returns Agent: presentation script (about 10 minutes)

## 1. The problem (1 min)

> "Customer complaints about deliveries arrive by email: damaged goods, wrong prices, missing quantities.
> Today someone reads each one, looks up the invoice in SAP, decides what to do, and creates a return or
> credit memo by hand. That is slow, inconsistent, and an approval can easily be skipped."

## 2. The solution in one sentence (30 s)

> "An agent that reads the complaint, checks it against the real invoice in SAP, proposes a decision based
> on nine business rules, and only creates the SAP document after the right person has approved it."

## 3. How it works (2 min)

Show the flow (whiteboard or slide):

```
Email / Agent  ->  proposeAction  ->  logRequest  ->  setApprovalStatus  ->  createReturn / createCreditMemoRequest  ->  release
                   (rule R1–R9)       (audit log,      (role-based tier,      (SAP document with                         (remove
                                       PENDING)         SAP re-check)          billing block 08)                          block)
```

- **Built on SAP BTP:** CAP service on Cloud Foundry, HANA for the audit log, destination `DS4` to S/4HANA.
- **Standard SAP APIs only:** billing document, customer return, credit memo request and pricing condition. Nothing is custom-built in SAP.
- **Nine rules:**
  - R1/R2: return the goods (damaged in transit, defective).
  - R3/R4/R5: credit without a return (ruined goods, overpriced, short delivery).
  - R6: replacement.
  - R7/R8: reject (claim exceeds invoice, duplicate).
  - R9: ask the customer.
- **Approval tiers by value:**
  - up to 500 EUR: customer service lead
  - up to 5,000 EUR: credit manager
  - above that: finance director
  - Credit-only rules (R3/R4/R5) always need at least a credit manager, and any credit above 5,000 EUR goes to the finance director, whatever the rule.
- **Safety built in:**
  - no SAP document without a matching approval
  - duplicate checks in the audit log and in SAP
  - billing block 08 until release
  - inputs are validated before they reach SAP

## 4. Live demo (4 min)

Use a **fresh invoice** that has no return yet. Invoice 90000376 was already used in testing and will now
correctly return R8.

```bash
B=https://o2c-returns-agent.cfapps.ap21.hana.ondemand.com/odata/v4/returns
INV=<fresh invoice>; MAT=<material>; CUST=<sold-to>     # from getInvoice
```

1. **Look at the invoice:**
   ```bash
   curl "$B/getInvoice(invoiceNumber='$INV')"
   ```
2. **Let the agent decide:**
   ```bash
   curl "$B/proposeAction(invoiceNumber='$INV',invoiceItem='10',material='$MAT',quantity=2,claimedAmount=0,reason='goods%20are%20defective',soldToParty='$CUST')"
   ```
   Say: "R2, a return. It calculated the credit from the invoice price and picked the approver."
3. **Log it and approve it:**
   ```bash
   curl -X POST "$B/logRequest" -H 'Content-Type: application/json' -d '{"invoiceNumber":"'$INV'","proposedAction":"RETURN","rule":"R2","reason":"defective","claimedQuantity":2,"creditValue":<value>}'
   curl -X POST "$B/setApprovalStatus" -H 'Content-Type: application/json' -d '{"ID":"<ID>","status":"APPROVED","approvedBy":"demo","approverRole":"credit-manager"}'
   ```
4. **Show a guardrail.** Try to create the document with a different rule. The request is refused with a 400:
   ```bash
   curl -X POST "$B/createReturn" ... '"rule":"R1"' ...      # -> "rule R1 does not match approved request (R2)"
   ```
5. **Create the return in SAP:**
   ```bash
   curl -X POST "$B/createReturn" ... '"rule":"R2"' ...      # -> CustomerReturn 6000xxxx
   ```
   Optional: show the document in SAP (VA03). It has customer reference `COMPLAINT-<invoice>` and billing block 08.
6. **Release it and show the duplicate check.** Run `releaseCustomerReturn`, then call `proposeAction` again on the same invoice. It now returns **R8, duplicate**.

**Backup if the live system is down.** Show the results from the 5 Oct test on invoice 90000376:

| Step | Result |
|---|---|
| Proposal | R2, 540 EUR, credit manager |
| Wrong rule | 400 |
| Return created | 60000164, with ETag |
| Release | RELEASED |
| Second proposal | R8 |

## 5. Quality and what we fixed (1 min)

- **55 automated tests** with a simulated SAP system (`npm test`), so they run without touching DS4.
- **Fixed during hardening:**
  - The duplicate check and the price lookup against SAP never actually ran. They do now.
  - The ETag needed to change documents was never stored.
  - An approval could be reused for a different document.
  - Inputs are now validated before they go into SAP URLs.
  - Large credit-only claims (R3/R4/R5) were capped at credit manager approval. They now go to the finance director above 5,000 EUR.
  - The R4 price check now uses the customer from the invoice, so it also works when the email names no customer.
- **Deployment:**
  - one MTA deploy
  - backup archive and rollback ready
  - email settings kept outside git

## 6. Next steps (30 s)

- Real authentication with XSUAA roles instead of the dummy auth used for the demo.
- Read the goods receipt status from the return items, so credits are released automatically after receipt.
- A Fiori approval inbox, and smarter email parsing (item numbers, attachments as evidence).

## Likely questions

- **"Can the agent create documents on its own?"** No. Every SAP document needs an approved audit entry for that exact invoice and rule, approved by the right role.
- **"What if SAP is down?"** The proposal falls back to R9 (manual), and creating a document fails cleanly. Nothing half-done is left in SAP.
- **"What if two people approve at once?"** The approval update is atomic, so only the first one counts. The second gets a 409.
- **"Who approves a large credit?"** Above 5,000 EUR always the finance director, for every rule. For example, an 8,100 EUR "ruined goods" credit (R3) needs the finance director, and a credit manager trying to approve it gets a 403.
- **"What about duplicates created directly in SAP?"** The app checks SAP when it proposes and again before approval.
