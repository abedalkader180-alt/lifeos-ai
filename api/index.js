// Vercel Node.js serverless entrypoint.
require('../src/config');
const { app } = require('../src/app');
module.exports = app;
