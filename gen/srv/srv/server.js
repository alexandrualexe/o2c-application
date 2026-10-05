const cds = require('@sap/cds');

cds.on('served', async () => {
  if (process.env.EMAIL_ENABLED !== 'true') return;
  const srv = await cds.connect.to('ReturnsService');
  require('./email-listener').start(srv);
});

module.exports = cds.server;