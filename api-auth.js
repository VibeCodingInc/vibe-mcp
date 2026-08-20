const config = require('./config');

function apiHeaders(extra = {}) {
  const token = config.getAuthToken();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

module.exports = { apiHeaders };
