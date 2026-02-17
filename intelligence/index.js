/**
 * Intelligence Module — Ambient Social Awareness
 *
 * Two shipped layers:
 * 1. Infer — Smart state detection from context signals
 * 2. Serendipity — Surface meaningful coincidences
 */

const infer = require('./infer');
const serendipity = require('./serendipity');

module.exports = {
  // Inference
  inferState: infer.inferState,
  enhanceUserWithInference: infer.enhanceUserWithInference,
  enhanceUsersWithInference: infer.enhanceUsersWithInference,
  STATES: infer.STATES,

  // Serendipity
  findSerendipity: serendipity.findSerendipity,
  getTopSerendipity: serendipity.getTopSerendipity,
  getAllSerendipity: serendipity.getAllSerendipity,
};
