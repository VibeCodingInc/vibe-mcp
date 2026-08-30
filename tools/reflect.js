/**
 * vibe reflect — the private-reflection verb (VibeStats provider).
 *
 * Reflection is a LENS on the person's own activity, computed locally by the
 * provider and shown only to them. Nothing here publishes; approved prose
 * still travels only through vibe_dm / vibe_reply after a human decision.
 *
 * Provider contract (smallest honest adapter): an executable `vibestats` on
 * PATH (or VIBE_STATS_CLI=/path), invoked as `vibestats reflect --json
 * <question>`, returning JSON { reflection: string, source?: string }. Where
 * no provider exists the verb says so — it never fabricates a reflection.
 */

const { execFile } = require('node:child_process');
const capabilities = require('../capabilities');

const REFLECT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

const definition = {
  name: 'vibe_reflect',
  description:
    'Ask the user’s own local VibeStats provider for one private reflection about their activity (patterns, cadence, streaks). Local-only: raw analytics inputs never leave this machine and nothing publishes without explicit human approval. Reports the capability state honestly when no provider exists.',
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        maxLength: 500,
        description: 'What to reflect on, in plain words (e.g. "how has my messaging cadence with @sam changed?").',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
};

function runProvider(cli, question) {
  return new Promise((resolve) => {
    execFile(
      cli,
      ['reflect', '--json', String(question)],
      { timeout: REFLECT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && typeof parsed.reflection === 'string' && parsed.reflection.trim()) {
            return resolve(parsed);
          }
        } catch {
          /* fall through to null */
        }
        resolve(null);
      }
    );
  });
}

async function handler(args) {
  const cap = capabilities.manifest().reflect;
  if (cap.state !== 'available') {
    return {
      display: `reflect — ${cap.state} · ${cap.why}`,
      data: { silence: true, capability: cap },
    };
  }
  const cli = process.env.VIBE_STATS_CLI || 'vibestats';
  const result = await runProvider(cli, args.question);
  if (!result) {
    return {
      display: 'reflect — the provider answered with silence (no reflection for that question)',
      data: { silence: true },
    };
  }
  const source = result.source ? `\n_source: ${String(result.source).slice(0, 200)}_` : '';
  return {
    display: `**private reflection** (yours alone; share only by sending approved words)\n${result.reflection.slice(0, 2000)}${source}`,
    data: { reflection: result.reflection.slice(0, 2000), source: result.source || null },
  };
}

module.exports = { definition, handler };
