// =============================================================================
// Email listener: turns customer complaint emails into audit log entries
// -----------------------------------------------------------------------------
// Started from srv/server.js when EMAIL_ENABLED=true. Every EMAIL_POLL_MS it
// logs in to the IMAP mailbox, reads all unread emails and for each one:
//
//   1. parseEmail()     -> pull invoice number, material, quantity, amount,
//                          customer and the kind of complaint out of the text
//   2. proposeAction    -> ReturnsService decides the rule (R1–R9)
//   3. logRequest       -> creates a PENDING audit entry for approval
//
// The listener never creates SAP documents; that only happens after a human
// approves the entry. Emails are flagged in the mailbox so they are processed
// once:
//   \Seen                -> logged successfully
//   \Seen + $NeedsReview -> could not be handled automatically (missing data, R9)
//   \Seen + $Ignored     -> sender outside EMAIL_ALLOWED_DOMAINS
//   (left unread)        -> technical error, retried on the next poll
//
// Configuration (environment, set via email.mtaext on BTP):
//   EMAIL_HOST, EMAIL_PORT (993), EMAIL_USER, EMAIL_PASSWORD   IMAP access
//   EMAIL_POLL_MS (60000)                                      poll interval
//   EMAIL_ALLOWED_DOMAINS                                      sender allow-list
// =============================================================================

const cds = require('@sap/cds');
const { ImapFlow } = require('imapflow');       // IMAP client
const { simpleParser } = require('mailparser'); // Raw MIME -> subject, text, from

const LOG = cds.log('email');
const POLL_MS = Number(process.env.EMAIL_POLL_MS || 60000);
// Optional: comma-separated sender domains, e.g. "customer.com,gmail.com"
// Empty means every sender is accepted.
const ALLOWED = (process.env.EMAIL_ALLOWED_DOMAINS || '')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

// ---- Extract structured data from the email text ----
// Simple keyword/regex extraction; anything not found comes back as null and
// the email is flagged for manual review if the essentials are missing.
function parseEmail({ subject = '', text = '', from = '' }) {
  // Search subject and body together ("Invoice 90000123" is often in the subject)
  const body = `${subject}\n${text}`;
  const lower = body.toLowerCase();

  // Extract invoice number: "invoice 90000123", "Invoice no. 90000123", "invoice #: ..."
  // SAP billing documents are 8–10 digits.
  const invoice = body.match(/invoice\s*(?:no\.?|number|#)?\s*[:#]?\s*(\d{8,10})/i);

  // Extract material number: "material TG11", "material no: 54"
  const material = body.match(/material\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Za-z0-9_-]{1,40})/i);

  // Extract quantity and unit: "5 PC", "2,5 KG", "3 pieces"
  const qty = body.match(/(\d+(?:[.,]\d+)?)\s*(KG|PC|EA|ST|L|pieces?|units?)\b/i);

  // Extract claimed amount (for price disputes): "claim EUR 50", "refund of 12.50"
  const claimedAmount = body.match(/(?:claim|ask for|credit|refund)\s*(?:of|at|for)?\s*(?:EUR|€|\$)?s*(\d+(?:[.,]\d+)?)/i);

  // Extract customer/sold-to party (if provided): "customer 10021", "sold-to: 100001"
  const soldToParty = body.match(/(?:customer|party|sold-?to|account|cust[.]?\s*no\.?)\s*(?:#|:)?\s*(\d{5,6})/i);

  // Determine proposed action based on keywords.
  // Order matters: a price complaint wins over damage words, replacement over return.
  // proposeAction later makes the final rule decision from the reason text.
  let proposedAction = null;
  if (/wrong price|overcharg|price|too much|expensive/.test(lower)) {
    proposedAction = 'CREDIT';
  } else if (/replace|need.*new|send.*another|substitut|substitute|replacement/.test(lower)) {
    proposedAction = 'REPLACEMENT';
  } else if (/return|defect|faulty|damaged|broken|leak|ruin|contaminat|quality/.test(lower)) {
    proposedAction = 'RETURN';
  }

  // Extract reason (full complaint text, truncated)
  // Note: '.' does not match newlines, so this takes the first line of the body
  // (up to 500 characters); falls back to the subject for empty bodies.
  const reasonMatch = text.match(/^(.{1,500})/);
  const reason = reasonMatch ? reasonMatch[1].trim() : subject;

  return {
    invoiceNumber: invoice?.[1] || null,
    material: material?.[1] || null,
    quantity: qty ? parseFloat(qty[1].replace(',', '.')) : null,   // "2,5" -> 2.5
    unit: qty ? qty[2].toUpperCase() : null,
    claimedAmount: claimedAmount ? parseFloat(claimedAmount[1].replace(',', '.')) : null,
    soldToParty: soldToParty?.[1] || null,
    proposedAction,
    reason,
    from
  };
}

// ---- Process all unread emails once ----
async function pollOnce(srv) {
  // A fresh connection per poll keeps things simple and survives server restarts
  const client = new ImapFlow({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT || 993),
    secure: true,                 // IMAPS (TLS)
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
    logger: false                 // imapflow is very chatty otherwise
  });

  await client.connect();
  // Lock the inbox so flags are not changed by another session meanwhile
  const lock = await client.getMailboxLock('INBOX');

  try {
    // UIDs of all unread messages (UIDs are stable, sequence numbers are not)
    const uids = await client.search({ seen: false }, { uid: true });

    for (const uid of uids) {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      const parsed = await simpleParser(msg.source);
      const from = parsed.from?.value?.[0]?.address?.toLowerCase() || '';

      // Ignore senders outside the allowed domains
      if (ALLOWED.length && !ALLOWED.some((d) => from.endsWith('@' + d))) {
        LOG.warn('Ignored email from', from);
        await client.messageFlagsAdd(uid, ['\\Seen', '$Ignored'], { uid: true });
        continue;
      }

      const info = parseEmail({ ...parsed, from });

      // Minimum required: invoice number and proposed action
      if (!info.invoiceNumber || !info.proposedAction) {
        LOG.warn('Incomplete email, needs manual review:', parsed.subject, info);
        await client.messageFlagsAdd(uid, ['\\Seen', '$NeedsReview'], { uid: true });
        continue;
      }

      try {
        // Step 1: Call proposeAction to get rule, reasoning, and credit value.
        // Runs as a privileged user because there is no logged-in user here.
        const proposal = await srv.tx({ user: cds.User.privileged }, (tx) =>
          tx.send('proposeAction', {
            invoiceNumber: info.invoiceNumber,
            invoiceItem: '10', // Default item; may be extracted from email in future
            material: info.material || '',
            quantity: info.quantity || 0,
            claimedAmount: info.claimedAmount || 0,
            reason: info.reason || info.proposedAction,
            soldToParty: info.soldToParty || ''
          })
        );

        // Step 2: Only log if proposal succeeded and rule is not R9 (uncertain)
        if (!proposal || !proposal.rule) {
          LOG.warn('proposeAction returned no rule:', parsed.subject, proposal);
          await client.messageFlagsAdd(uid, ['\\Seen', '$NeedsReview'], { uid: true });
          continue;
        }

        if (proposal.rule === 'R9') {
          // R9: invoice not found or ambiguous; flag for manual review
          LOG.info('R9 proposal (manual review needed):', parsed.subject, proposal.reasoning);
          await client.messageFlagsAdd(uid, ['\\Seen', '$NeedsReview'], { uid: true });
          continue;
        }

        // Step 3: Log the request with the rule, credit value, and reasoning.
        // This creates the PENDING audit entry an approver will see.
        const entry = await srv.tx({ user: cds.User.privileged }, (tx) =>
          tx.send('logRequest', {
            invoiceNumber: info.invoiceNumber,
            proposedAction: proposal.proposedAction,
            rule: proposal.rule,
            reason: proposal.reasoning,
            claimedQuantity: info.quantity || 0,
            claimedAmount: info.claimedAmount || 0,
            creditValue: proposal.creditValue || 0,
            evidenceUrl: null // Can be extracted from email attachments later
          })
        );

        LOG.info('Logged request', entry?.ID, {
          from,
          rule: proposal.rule,
          invoice: info.invoiceNumber,
          creditValue: proposal.creditValue
        });

        // Mark as read only after successful logging
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      } catch (err) {
        LOG.error('Email processing failed for', parsed.subject, err.message);
        // Leave unseen so it will be retried on next poll
      }
    }
  } finally {
    // Always release the mailbox and disconnect, even after an error
    lock.release();
    await client.logout();
  }
}

// ---- Start polling (skips a run if the previous one is still busy) ----
function start(srv) {
  // Without credentials the app still runs, just without the email channel
  const missing = ['EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASSWORD'].filter((k) => !process.env[k]);
  if (missing.length) {
    LOG.warn('Email listener disabled, missing:', missing.join(', '));
    return;
  }

  // Guard against overlapping polls when one run takes longer than POLL_MS
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await pollOnce(srv); }
    catch (err) { LOG.error('Poll failed:', err.message); }   // e.g. mailbox unreachable; try again next tick
    finally { running = false; }
  };

  LOG.info(`Email listener started, polling every ${POLL_MS / 1000}s`);
  tick();                         // First poll right away
  setInterval(tick, POLL_MS);     // Then on a fixed interval
}

// parseEmail is exported as well so it can be unit-tested
module.exports = { start, parseEmail };
