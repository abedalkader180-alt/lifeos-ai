require('./src/config');
const { app } = require('./src/app');
const db = require('./src/db');

const PORT = process.env.PORT || 3000;

db.initSchema()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[lifeos] listening on http://0.0.0.0:${PORT}`);
      console.log(`[lifeos] database: ${db.IS_PG ? 'postgres' : 'sqlite'}`);
      console.log(`[lifeos] AI enabled: ${process.env.AI_ENABLED === 'true' && !!process.env.AI_API_KEY}`);
    });
  })
  .catch((err) => {
    console.error('[lifeos] failed to init schema', err);
    process.exit(1);
  });
