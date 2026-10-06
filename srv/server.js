// =============================================================================
// Custom server bootstrap
// -----------------------------------------------------------------------------
// CAP picks this file up automatically (srv/server.js) and uses it instead of
// its built-in server. We only use it to hook into the startup sequence; the
// HTTP server itself is still CAP's default (exported at the bottom).
// =============================================================================

const cds = require('@sap/cds');

// 'served' fires once all services are up and their handlers are registered.
// Only then is it safe to call ReturnsService actions from the email listener.
cds.on('served', async () => {
  // The email poller is opt-in: without EMAIL_ENABLED=true (set in the
  // email.mtaext deployment extension) the app runs as a pure API.
  if (process.env.EMAIL_ENABLED !== 'true') return;

  // Connect to our own service in-process (no HTTP round trip)
  const srv = await cds.connect.to('ReturnsService');
  require('./email-listener').start(srv);
});

// Keep CAP's standard server (express app, OData endpoints, health checks)
module.exports = cds.server;
