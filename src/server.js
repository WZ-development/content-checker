'use strict';

require('dotenv').config();

const { loadConfig, ConfigError } = require('./config');
const { createApp } = require('./app');

/**
 * Sprint 7, requirement 2: pure text-building, factored out of main() so
 * it's directly unit-testable without needing to spin up a real server
 * or capture console output at import time (main() runs immediately on
 * require otherwise). Never receives or returns the token itself — only
 * `Boolean(config.outboundToken)` in, a fixed string out — so there is
 * nothing here that could leak the value even by accident.
 */
function describeOutboundTokenStartupNotice(outboundTokenConfigured) {
  if (outboundTokenConfigured) {
    return '[content-checker] outbound identification token is configured.';
  }
  return (
    '[content-checker] outbound identification token is not configured (CONTENTCHECK_OUTBOUND_TOKEN unset) — ' +
    'outbound requests will not carry it. Run `npm run generate-outbound-token` to generate one.'
  );
}

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

  // Sprint 7, requirement 2: unset is a fully supported, normal-startup
  // state — this notice is informational, not a warning — but it should
  // still be visible so an operator who meant to set the token notices
  // its absence at a glance rather than discovering it only when a CDN
  // challenge shows up later.
  console.log(describeOutboundTokenStartupNotice(Boolean(config.outboundToken)));

  const app = createApp(config);
  app.listen(config.port, () => {
    const mountPath = config.basePath === '' ? '/' : config.basePath;
    console.log(
      `[content-checker] listening on port ${config.port}, mounted at ${mountPath}`
    );
  });
}

module.exports = { describeOutboundTokenStartupNotice };

if (require.main === module) {
  main();
}
