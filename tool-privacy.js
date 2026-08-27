/**
 * Tool-call privacy policy exercised by the dispatcher.
 *
 * A Personal Mind call contains an unsent thought. It is neither a product
 * prompt pattern nor presence activity, so the dispatcher must retain and
 * append nothing around its explicit result.
 */

const PRIVATE_INPUT_TOOLS = new Set(['vibe_mind']);

function retainedPrompt(toolName, args, inferPromptFromArgs) {
  if (PRIVATE_INPUT_TOOLS.has(toolName)) return null;
  return args._prompt || inferPromptFromArgs(toolName, args);
}

function shouldAppendAmbientFooter(toolName, ordinarySkipTools) {
  return !PRIVATE_INPUT_TOOLS.has(toolName) && !ordinarySkipTools.includes(toolName);
}

module.exports = { retainedPrompt, shouldAppendAmbientFooter };
