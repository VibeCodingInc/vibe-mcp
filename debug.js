/**
 * Debug logging — conditional on VIBE_DEBUG env var
 *
 * @param {...*} args Arguments to log
 */
function debug(...args) {
  if (process.env.VIBE_DEBUG === 'true') {
    console.error(...args);
  }
}

module.exports = debug;
