# O2C Returns Agent: presentation script (about 12 minutes)

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

## 5. The Control Tower view (2 min)

> "The same service also feeds the Reclaim Control Tower. It looks at the whole order-to-cash process,
> finds where money is stuck, and says which agent should pick it up. And it can't change anything."

- **Eight read-only functions** in the same CAP service, on the same `DS4` destination. They are all OData
  functions (GET), with no actions, so there is no write path at all.
- **Every answer shows its sources.** Each one returns `underlyingRequests` (the exact SAP GETs it made) and `capturedOn`.
  The Control Tower shows these in its request log.
- **One function per row of the L4 table:**

| L4 | What it finds | Routed to | Function |
|---|---|---|---|
| 3.4.1 | Goods issued 3+ days ago, POD still open | 6 POD Chaser | `listDeliveriesAwaitingPod` |
| 4.1.1 | Shipped, not billed | 7 Billing Gatekeeper | `listUnbilledDeliveries`, `listBillingDueList` |
| 2.3.3 · 4.1.4 | Credit, delivery and billing blocks | 3 Block Buster | `listBlockedOrders` |
| 5.2.1 | Return older than 7 days, no credit memo | 8 Returns & Credit | `listReturnsWithoutCredit` |
| 6.1.2 | Overdue receivables per customer | 9 Cash Application | `listOverdueReceivables` |

- **One order end to end:** `checkOrderConformance` follows order → delivery → invoice and gives one finding per cause.
  - If POD is still open, the finding is 3.4.1, not "unbilled".
  - If the order is blocked for billing, it's 4.1.4.
  - A cancelled invoice doesn't count as billed.

**Demo (read-only, safe to run any time):**

```bash
B=https://o2c-returns-agent.cfapps.ap21.hana.ondemand.com/odata/v4/returns
curl -s "$B/listOverdueReceivables(companyCode='YDE1',keyDate='2026-10-01')"   # 368 598.40 EUR, as in the guide
curl -s "$B/checkOrderConformance(salesOrder='1876')"                          # 3.4.1: POD open on 80608983
curl -s "$B/checkOrderConformance(salesOrder='1937')"                          # conforms: delivery 80609033 -> invoice 90000455
curl -s "$B/checkOrderConformance(salesOrder='1832')"                          # 2.3.3: credit block, a person decides
```

Say: "Same numbers as the organisers' reference snapshot, read live from SAP, and each answer lists the requests it made."

**Live numbers (6 Oct):**
- 178 unbilled deliveries, 83 of them waiting for POD
- 144 blocked orders
- 368 598.40 EUR and 150 RON overdue on 1 Oct
- 51 returns without a credit memo

**Built for the real system:**
- The billing due list fails a whole page when one row is unreadable. The function re-reads that page row by row and reports `skippedRows`.
- Returns delivery items give the real goods-receipt status (`getReturnStatus`, e.g. return 60000014 → delivery 84000000, received).

## 6. Quality and what we fixed (1 min)

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

## 7. Next steps (30 s)

- Real authentication with XSUAA roles instead of the dummy auth used for the demo.
- Release credits automatically once `getReturnStatus` reports the goods received (the status is read already).
- A Fiori approval inbox, and smarter email parsing (item numbers, attachments as evidence).

## Likely questions

- **"Can the agent create documents on its own?"** No. Every SAP document needs an approved audit entry for that exact invoice and rule, approved by the right role.
- **"What if SAP is down?"** The proposal falls back to R9 (manual), and creating a document fails cleanly. Nothing half-done is left in SAP.
- **"What if two people approve at once?"** The approval update is atomic, so only the first one counts. The second gets a 409.
- **"Who approves a large credit?"** Above 5,000 EUR always the finance director, for every rule. For example, an 8,100 EUR "ruined goods" credit (R3) needs the finance director, and a credit manager trying to approve it gets a 403.
- **"What about duplicates created directly in SAP?"** The app checks SAP when it proposes and again before approval.
- **"Can the Control Tower change anything in SAP?"** No. It has only OData functions (GET) and no actions. Each answer lists the SAP requests it made, and they are all GETs.
- **"Why do your numbers differ from the guide?"** The guide is a 1 Oct snapshot. With `keyDate='2026-10-01'`, overdue receivables match exactly. Today's counts differ because deliveries have aged: more are past 14 days, and fewer are inside the grace period.
