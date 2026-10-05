const cds = require('@sap/cds');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const LOG = cds.log('email');
const POLL_MS = Number(process.env.EMAIL_POLL_MS || 60000);
// Optional: comma-separated sender domains, e.g. "customer.com,gmail.com"
const ALLOWED = (process.env.EMAIL_ALLOWED_DOMAINS || '')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

// ---- Extract structured data from the email text ----
function parseEmail({ subject = '', text = '' }) {
  const body = `${subject}\n${text}`;
  const lower = body.toLowerCase();

  const invoice = body.match(/invoice\s*(?:no\.?|number|#)?\s*[:#]?\s*(\d{8,10})/i);
  const material = body.match(/material\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Za-z0-9_-]{1,40})/i);
  const qty = body.match(/(\d+(?:[.,]\d+)?)\s*(KG|PC|EA|ST|L)\b/i);

  let proposedAction = null;
  if (/wrong price|overcharg|price/.test(lower)) proposedAction = 'CREDIT';
  else if (/damaged|broken|replace/.test(lower)) proposedAction = 'REPLACEMENT';
  else if (/return|defect|faulty/.test(lower)) proposedAction = 'RETURN';

  return {
    invoiceNumber: invoice?.[1] || null,
    material: material?.[1] || null,
    quantity: qty ? qty[1].replace(',', '.') : null,
    unit: qty ? qty[2].toUpperCase() : null,
    proposedAction
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

      const info = parseEmail(parsed);

      // Not enough information: flag it for manual review, don't guess
      if (!info.invoiceNumber || !info.proposedAction) {
        LOG.warn('Needs manual review:', parsed.subject, info);
        await client.messageFlagsAdd(uid, ['\\Seen', '$NeedsReview'], { uid: true });
        continue;
      }

      try {
        const entry = await srv.tx({ user: cds.User.privileged }, (tx) =>
          tx.send('logRequest', {
            invoiceNumber: info.invoiceNumber,
            proposedAction: info.proposedAction
          })
        );
        LOG.info('Logged request', entry?.ID, { from, ...info });
        // Mark as read only after success, so failures are retried on the next poll
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      } catch (err) {
        LOG.error('logRequest failed for', parsed.subject, err.message);
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