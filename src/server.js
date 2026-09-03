'use strict';

require('dotenv').config();

const { loadConfig, ConfigError } = require('./config');
const { createApp } = require('./app');

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Explicit, named failure — never fall back to a default secret.
      console.error(`[content-checker] Startup failed: ${err.message}`);
      process.exit(1);
      return;
    }
    throw err;
  }

  const app = createApp(config);
  app.listen(config.port, () => {
    const mountPath = config.basePath === '' ? '/' : config.basePath;
    console.log(
      `[content-checker] listening on port ${config.port}, mounted at ${mountPath}`
    );
  });
}

main();
