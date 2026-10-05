const cds = require('@sap/cds');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const LOG = cds.log('email');
const POLL_MS = Number(process.env.EMAIL_POLL_MS || 60000);
// Optional: comma-separated sender domains, e.g. "customer.com,gmail.com"
const ALLOWED = (process.env.EMAIL_ALLOWED_DOMAINS || '')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

// ---- Extract structured data from the email text ----
function parseEmail({ subject = '', text = '', from = '' }) {
  const body = `${subject}\n${text}`;
  const lower = body.toLowerCase();

  // Extract invoice number
  const invoice = body.match(/invoice\s*(?:no\.?|number|#)?\s*[:#]?\s*(\d{8,10})/i);
  
  // Extract material number
  const material = body.match(/material\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Za-z0-9_-]{1,40})/i);
  
  // Extract quantity and unit
  const qty = body.match(/(\d+(?:[.,]\d+)?)\s*(KG|PC|EA|ST|L|pieces?|units?)\b/i);
  
  // Extract claimed amount (for price disputes)
  const claimedAmount = body.match(/(?:claim|ask for|credit|refund)\s*(?:of|at|for)?\s*(?:EUR|€|\$)?s*(\d+(?:[.,]\d+)?)/i);
  
  // Extract customer/sold-to party (if provided)
  const soldToParty = body.match(/(?:customer|party|sold-?to|account|cust[.]?\s*no\.?)\s*(?:#|:)?\s*(\d{5,6})/i);

  // Determine proposed action based on keywords
  let proposedAction = null;
  if (/wrong price|overcharg|price|too much|expensive/.test(lower)) {
    proposedAction = 'CREDIT';
  } else if (/replace|need.*new|send.*another|substitut|substitute|replacement/.test(lower)) {
    proposedAction = 'REPLACEMENT';
  } else if (/return|defect|faulty|damaged|broken|leak|ruin|contaminat|quality/.test(lower)) {
    proposedAction = 'RETURN';
  }

  // Extract reason (full complaint text, truncated)
  const reasonMatch = text.match(/^(.{1,500})/);
  const reason = reasonMatch ? reasonMatch[1].trim() : subject;

  return {
    invoiceNumber: invoice?.[1] || null,
    material: material?.[1] || null,
    quantity: qty ? parseFloat(qty[1].replace(',', '.')) : null,
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
  const client = new ImapFlow({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT || 993),
    secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
    logger: false
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  try {
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
        // Step 1: Call proposeAction to get rule, reasoning, and credit value
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

        // Step 3: Log the request with the rule, credit value, and reasoning
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
    lock.release();
    await client.logout();
  }
}

// ---- Start polling (skips a run if the previous one is still busy) ----
function start(srv) {
  const missing = ['EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASSWORD'].filter((k) => !process.env[k]);
  if (missing.length) {
    LOG.warn('Email listener disabled, missing:', missing.join(', '));
    return;
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await pollOnce(srv); }
    catch (err) { LOG.error('Poll failed:', err.message); }
    finally { running = false; }
  };

  LOG.info(`Email listener started, polling every ${POLL_MS / 1000}s`);
  tick();
  setInterval(tick, POLL_MS);
}

module.exports = { start, parseEmail };