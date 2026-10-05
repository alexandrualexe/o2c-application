const cds = require('@sap/cds');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const LOG = cds.log('email');
const POLL_MS = Number(process.env.EMAIL_POLL_MS || 60000);
// Optional: comma-separated sender domains, e.g. "customer.com,gmail.com"
const ALLOWED = (process.env.EMAIL_ALLOWED_DOMAINS || '')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

const DEFAULT_INVOICE_ITEM = '10';
const REASON_MAX_LENGTH = 1000;
// After this many failed attempts (e.g. SAP down for hours) an email goes to manual review
const MAX_ATTEMPTS = Number(process.env.EMAIL_MAX_ATTEMPTS || 10);

// Free-text units mapped to SAP unit codes
const UNIT_ALIASES = { PIECE: 'PC', PIECES: 'PC', UNIT: 'PC', UNITS: 'PC' };
const UNIT_PATTERN = 'KG|PC|EA|ST|L|pieces?|units?';

// ---- Determine proposed action based on keywords ----
function detectAction(text = '') {
  const lower = text.toLowerCase();
  if (/wrong price|overcharg|price|too much|expensive/.test(lower)) return 'CREDIT';
  if (/replace|need.*new|send.*another|substitut|replacement/.test(lower)) return 'REPLACEMENT';
  if (/return|defect|faulty|damaged|broken|leak|ruin|contaminat|quality/.test(lower)) return 'RETURN';
  return null;
}

// ---- Extract structured data from the email text ----
function parseEmail({ subject = '', text = '', from = '' }) {
  subject = subject || '';
  text = text || '';
  const body = `${subject}\n${text}`;

  // Extract invoice number
  const invoice = body.match(/invoice\s*(?:no\.?|number|#)?\s*[:#]?\s*(\d{8,10})/i);

  // Extract invoice line item (e.g. "item 20", "position: 30")
  const item = body.match(/\b(?:item|pos(?:ition)?)\s*(?:no\.?|number|#)?\s*[:#]?\s*(\d{1,6})\b/i);

  // Extract material number (must contain a digit, so "materials are broken" is not a material)
  const material = body.match(/material\s*(?:no\.?|number|nr\.?|#)?\s*[:#]?\s*((?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{1,40})/i);

  // Extract quantity and unit
  const qty = body.match(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_PATTERN})\\b`, 'i'));

  // Extract claimed amount (for price disputes); skip numbers followed by a unit, those are quantities
  const claimedAmount = body.match(new RegExp(
    `(?:claim(?:ing)?|ask(?:ing)? for|credit|refund)\\s*(?:of|at|for)?\\s*(?:a\\s+)?(?:EUR|€|\\$)?\\s*` +
    `(\\d+(?:[.,]\\d+)?)(?!\\d|[.,]\\d)(?!\\s*(?:${UNIT_PATTERN})\\b)`,
    'i'
  ));

  // Extract customer/sold-to party (if provided)
  const soldToParty = body.match(/(?:customer|party|sold-?to|account|cust[.]?\s*no\.?)\s*(?:#|:)?\s*(\d{5,6})/i);

  // Reason: subject and full body, whitespace collapsed and truncated
  const reason = body.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX_LENGTH);

  const unit = qty ? qty[2].toUpperCase() : null;
  const amount = claimedAmount ? claimedAmount[1] : null;

  return {
    invoiceNumber: invoice?.[1] || null,
    invoiceItem: item?.[1] || null,
    material: material?.[1] || null,
    quantity: qty ? parseFloat(qty[1].replace(',', '.')) : null,
    unit: unit ? (UNIT_ALIASES[unit] || unit) : null,
    // An invoice number is never a claimed amount
    claimedAmount: amount && amount !== invoice?.[1] ? parseFloat(amount.replace(',', '.')) : null,
    soldToParty: soldToParty?.[1] || null,
    proposedAction: detectAction(body),
    reason,
    from
  };
}

// Drop null/undefined/'' overrides so they don't wipe parsed values
function definedOnly(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '')
  );
}

// ---- Run one complaint through proposeAction + logRequest and record it in InboundEmails ----
// Used by the IMAP poller and by the processComplaint / reprocessInboundEmail actions.
// Runs in the caller's transaction (the request, or the poller's per-email transaction).
async function processComplaint(srv, {
  subject = '', text = '', from = '', messageId = null, inboundEmailID = null, overrides = {}
}) {
  const { InboundEmails } = srv.entities;
  const corrections = definedOnly(overrides);
  const info = { ...parseEmail({ subject, text, from }), ...corrections };
  if (corrections.reason) info.proposedAction = detectAction(corrections.reason) || info.proposedAction;

  // Find an earlier record of this complaint (same row is updated, never duplicated)
  const existing = inboundEmailID
    ? await SELECT.one.from(InboundEmails).where({ ID: inboundEmailID })
    : messageId
      ? await SELECT.one.from(InboundEmails).where({ messageId })
      : null;

  const result = {
    inboundEmailID: existing?.ID || cds.utils.uuid(),
    status: null,
    statusReason: null,
    auditLogID: null,
    rule: null,
    proposedAction: info.proposedAction,
    reasoning: null,
    creditValue: null,
    requiredApprover: null,
    invoiceNumber: info.invoiceNumber,
    invoiceItem: info.invoiceItem || DEFAULT_INVOICE_ITEM,
    material: info.material,
    quantity: info.quantity,
    claimedAmount: info.claimedAmount,
    soldToParty: info.soldToParty
  };

  // Already logged: never create a second audit entry
  if (existing?.status === 'LOGGED') {
    return { ...result, status: 'LOGGED', statusReason: 'Already logged', auditLogID: existing.auditLog_ID, rule: existing.rule };
  }

  if (!info.invoiceNumber || !info.proposedAction) {
    result.status = 'NEEDS_REVIEW';
    result.statusReason = !info.invoiceNumber
      ? 'No invoice number found'
      : 'Complaint type unclear (price, damage/defect, or replacement?)';
  } else {
    try {
      // Step 1: Call proposeAction to get rule, reasoning, and credit value
      const proposal = await srv.send('proposeAction', {
        invoiceNumber: info.invoiceNumber,
        invoiceItem: result.invoiceItem,
        material: info.material || '',
        quantity: info.quantity || 0,
        claimedAmount: info.claimedAmount || 0,
        reason: info.reason || info.proposedAction,
        soldToParty: info.soldToParty || ''
      });

      Object.assign(result, {
        rule: proposal?.rule || null,
        proposedAction: proposal?.proposedAction || result.proposedAction,
        reasoning: proposal?.reasoning || null,
        creditValue: proposal?.creditValue ?? null,
        requiredApprover: proposal?.requiredApprover || null
      });

      // Step 2: R9 (or no rule) means a human or the agent has to clarify
      if (!proposal?.rule || proposal.rule === 'R9') {
        result.status = 'NEEDS_REVIEW';
        result.statusReason = proposal?.reasoning || 'proposeAction returned no rule';
      } else {
        // Step 3: Log the request with the rule, credit value, and reasoning
        const entry = await srv.send('logRequest', {
          invoiceNumber: info.invoiceNumber,
          invoiceItem: result.invoiceItem,
          material: info.material || null,
          proposedAction: proposal.proposedAction,
          rule: proposal.rule,
          reason: proposal.reasoning,
          claimedQuantity: info.quantity || 0,
          claimedAmount: info.claimedAmount || 0,
          creditValue: proposal.creditValue || 0,
          evidenceUrl: null // Can be extracted from email attachments later
        });
        result.status = 'LOGGED';
        result.auditLogID = entry?.ID || null;
      }
    } catch (err) {
      // FAILED = retryable; the poller leaves the email unread and tries again next poll
      result.status = 'FAILED';
      result.statusReason = err.message;
    }
  }

  const attempts = result.status === 'FAILED' ? (existing?.attempts || 0) + 1 : (existing?.attempts || 0);
  if (result.status === 'FAILED' && attempts >= MAX_ATTEMPTS) {
    result.status = 'NEEDS_REVIEW';
    result.statusReason = `Gave up after ${attempts} attempts: ${result.statusReason}`;
  }

  await UPSERT.into(InboundEmails).entries({
    ID: result.inboundEmailID,
    messageId: messageId || existing?.messageId || null,
    fromAddress: from || existing?.fromAddress || null,
    subject,
    body: text,
    status: result.status,
    statusReason: result.statusReason,
    attempts,
    invoiceNumber: result.invoiceNumber,
    invoiceItem: result.invoiceItem,
    material: result.material,
    quantity: result.quantity,
    unit: info.unit,
    claimedAmount: result.claimedAmount,
    soldToParty: result.soldToParty,
    reason: info.reason,
    rule: result.rule,
    auditLog_ID: result.auditLogID
  });

  return result;
}

// ---- Process all unread emails once ----
async function pollOnce(srv) {
  const counts = { processed: 0, logged: 0, needsReview: 0, failed: 0, ignored: 0 };
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
        counts.ignored++;
        continue;
      }

      counts.processed++;
      // One transaction per email: the InboundEmail row and its audit entry commit together
      const result = await srv.tx({ user: cds.User.privileged }, () => processComplaint(srv, {
        subject: parsed.subject,
        text: parsed.text,
        from,
        messageId: parsed.messageId || null
      }));

      if (result.status === 'LOGGED') {
        counts.logged++;
        LOG.info('Logged request', result.auditLogID, {
          from, rule: result.rule, invoice: result.invoiceNumber, creditValue: result.creditValue
        });
        // Mark as read only after successful logging
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      } else if (result.status === 'NEEDS_REVIEW') {
        counts.needsReview++;
        LOG.warn('Needs manual review:', parsed.subject, result.statusReason);
        await client.messageFlagsAdd(uid, ['\\Seen', '$NeedsReview'], { uid: true });
      } else {
        counts.failed++;
        LOG.error('Email processing failed for', parsed.subject, result.statusReason);
        // Leave unseen so it will be retried on next poll
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }

  return counts;
}

const missingConfig = () => ['EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASSWORD'].filter((k) => !process.env[k]);

// Shared by the background timer and the pollInbox action, so polls never overlap
let running = false;
async function runPoll(srv) {
  if (running) return null;
  running = true;
  try { return await pollOnce(srv); }
  finally { running = false; }
}

// ---- Start polling (skips a run if the previous one is still busy) ----
function start(srv) {
  const missing = missingConfig();
  if (missing.length) {
    LOG.warn('Email listener disabled, missing:', missing.join(', '));
    return;
  }

  const tick = async () => {
    try { await runPoll(srv); }
    catch (err) { LOG.error('Poll failed:', err.message); }
  };

  LOG.info(`Email listener started, polling every ${POLL_MS / 1000}s`);
  tick();
  setInterval(tick, POLL_MS);
}

module.exports = { start, parseEmail, detectAction, processComplaint, runPoll, missingConfig };
