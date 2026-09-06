// Vercel Node.js serverless entrypoint.
require('../src/config');
const db = require('../src/db');
const { app } = require('../src/app');

// Make sure tables exist before serving requests.
db.initSchema().catch((e) => {
  console.error('[lifeos] init schema failed:', e);
});

module.exports = app;
