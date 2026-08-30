/**
 * vibe reflect — the private-reflection verb (VibeStats provider).
 *
 * Reflection is a LENS on the person's own activity, computed locally by the
 * provider and shown only to them. Nothing here publishes; approved prose
 * still travels only through vibe_dm / vibe_reply after a human decision.
 *
 * Provider contract (vibe-mcp#24 — the REAL VibeStats CLI, v0.1.x): an
 * executable `vibestats` on PATH or VIBE_STATS_CLI=/path, invoked as
 * `vibestats reveal --json`, returning the local reveal:
 *   { archetype, scores{...}, metrics{...}, raw_meta{ dateRange, source,
 *     version, ... } }
 * The provider reveals an archetype from local /insights-derived data; it
 * does not answer arbitrary questions, so this verb takes none — offering a
 * question box the provider cannot honor would be a fabricated capability.
 *
 * Distinct outcomes, never blurred (issue #24 acceptance):
 *   reflection      — valid reveal with an archetype, provenance attached
 *   no local data   — the provider ran, answered validly, had nothing
 *   provider failed — ran but errored / non-JSON / timed out
 *   unavailable/off — from the manifest; the provider was never run
 */

const { execFile } = require('node:child_process');
const capabilities = require('../capabilities');

const REFLECT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

const definition = {
  name: 'vibe_reflect',
  description:
    'Reveal the user’s own private VibeStats reflection — their local coding archetype and cadence, derived on this machine from their own /insights data. Local-only: raw inputs never leave the machine and nothing publishes without explicit human approval. Reports the capability state honestly when no provider exists.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

// The REAL CLI signals missing /insights data by exiting nonzero with this
// message (bin/vibestats.js cliErrorMessage) — that is NO DATA, not failure.
// NARROW on purpose (round-3): the CLI appends a usage-data advice footer to
// every insights-adjacent error, so a bare 'usage-data' match would swallow
// real failures (e.g. malformed metadata). Only the actual no-data throws
// qualify: the exact phrase, or the ENOENT of the usage-data files.
const NO_DATA_SIGNATURE = /No Claude Code \/insights session metadata found|ENOENT[^\n]*usage-data/;

function runProvider(cli) {
  return new Promise((resolve) => {
    execFile(
      cli,
      ['reveal', '--json'],
      { timeout: REFLECT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          const said = `${stderr || ''}\n${stdout || ''}`;
          if (NO_DATA_SIGNATURE.test(said)) return resolve({ noData: true });
          return resolve({ failed: true });
        }
        try {
          return resolve({ reveal: JSON.parse(stdout) });
        } catch {
          return resolve({ failed: true }); // non-JSON output is a provider fault
        }
      }
    );
  });
}

function renderReflection(reveal) {
  const metrics = reveal.metrics || {};
  const meta = reveal.raw_meta || {};
  const lines = [`**${reveal.archetype}** — your local archetype right now`];
  const cadence = [];
  if (Number.isFinite(metrics.sessions)) cadence.push(`${metrics.sessions} sessions`);
  if (Number.isFinite(metrics.days)) cadence.push(`${metrics.days} days`);
  if (Number.isFinite(metrics.commitsPerDay)) cadence.push(`${metrics.commitsPerDay} commits/day`);
  if (Number.isFinite(metrics.msgsPerSession)) cadence.push(`${metrics.msgsPerSession} msgs/session`);
  if (cadence.length) lines.push(cadence.join(' · '));
  const prov = [meta.source, meta.dateRange, meta.version && `vibestats ${meta.version}`]
    .filter(Boolean)
    .join(' · ');
  if (prov) lines.push(`_${prov}_`);
  return lines.join('\n');
}

async function handler() {
  // ONE discriminator, never blurred (review round 2): every result names its
  // outcome — reflection · no_data · provider_error · off · unavailable. No
  // shared `silence` flag exists for a consumer to collapse them through.
  const cap = capabilities.manifest().reflect;
  if (cap.state !== 'available') {
    return {
      display: `reflect — ${cap.state} · ${cap.why}`,
      data: { outcome: cap.state, capability: cap },
    };
  }
  const cli = process.env.VIBE_STATS_CLI || 'vibestats';
  const result = await runProvider(cli);
  if (result.failed) {
    return {
      display: 'reflect — the provider failed to answer (ran but errored); nothing was reflected',
      data: { outcome: 'provider_error' },
    };
  }
  if (result.noData) {
    return {
      display: 'reflect — the provider ran and found no local /insights data to reflect yet',
      data: { outcome: 'no_data' },
    };
  }
  const reveal = result.reveal;
  if (!reveal || typeof reveal.archetype !== 'string' || !reveal.archetype.trim()) {
    return {
      display: 'reflect — the provider ran and found no local data to reflect yet',
      data: { outcome: 'no_data' },
    };
  }
  return {
    display:
      `**private reflection** (yours alone; share only by sending approved words)\n` +
      renderReflection(reveal),
    data: {
      outcome: 'reflection',
      archetype: reveal.archetype,
      metrics: reveal.metrics || null,
      provenance: {
        source: reveal.raw_meta?.source || null,
        dateRange: reveal.raw_meta?.dateRange || null,
        version: reveal.raw_meta?.version || null,
      },
    },
  };
}

module.exports = { definition, handler };
