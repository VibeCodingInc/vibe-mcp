'use strict';

// Explicit navigation should not wait on the ambient room snapshot. This footer
// preserves the product stamp without inventing zero-valued counts for state we
// deliberately did not fetch.
const MINIMAL_FOOTER = '\n\n────────────────────────\nvibe';

async function resolveFooter(result, loadAmbientFooter) {
  if (result?.footer === 'minimal') return MINIMAL_FOOTER;
  return loadAmbientFooter();
}

module.exports = { resolveFooter, MINIMAL_FOOTER };
