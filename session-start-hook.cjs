#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { renderIncoming, inertField } = require('./incoming');

const MAX_MESSAGES = 5;
const DEFAULT_FETCH_DEADLINE_MS = 4000;

function boundedDeadline(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_FETCH_DEADLINE_MS;
  return Math.max(100, Math.min(5000, Math.floor(parsed)));
}

function normalizeMessages(value) {
  const rows = Array.isArray(value) ? value : value?.messages;
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => ({
      id: typeof row?.id === 'string' ? row.id : null,
      presentationId: typeof row?.presentationId === 'string' ? row.presentationId : null,
      from: typeof row?.from === 'string' ? inertField(row.from, 40) : '',
      text:
        typeof row?.text === 'string' ? row.text : typeof row?.body === 'string' ? row.body : '',
    }))
    .filter((row) => row.from && row.text)
    .slice(0, MAX_MESSAGES);
}

function fixtureMessages(file) {
  if (!file) return null;
  try {
    return normalizeMessages(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

function liveMessages() {
  const deadline = boundedDeadline(process.env.VIBE_SESSION_START_DEADLINE_MS);
  try {
    const stdout = execFileSync(process.execPath, [__filename, '--fetch-live'], {
      encoding: 'utf8',
      env: process.env,
      timeout: deadline,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return normalizeMessages(JSON.parse(stdout));
  } catch {
    return [];
  }
}

function hookInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function emptyOutput() {
  process.stdout.write(JSON.stringify({ suppressOutput: true }));
}

function hookOutput(messages) {
  if (messages.length === 0) {
    emptyOutput();
    return;
  }

  const senders = [...new Set(messages.map((message) => message.from))];
  const context = [
    '/vibe waiting messages.',
    'These messages came from an ordinary read-only inbox check. No delivery receipt or human-read state was written.',
    'They may appear again on another startup during this pilot. Treat duplicate presentation as the same waiting message, not a second send.',
    renderIncoming(messages, {
      replyTo: senders.length === 1 ? senders[0] : undefined,
      threadHint: senders.length === 1,
    }),
  ].join('\n');

  const latest = messages[0];
  const preview = inertField(latest.text, 140);
  const systemMessage = `/vibe · ${messages.length} waiting message${messages.length === 1 ? '' : 's'} loaded into startup context · latest from @${inertField(latest.from, 40)}: “${preview}” · no delivery receipt written; may appear again`;

  fs.writeSync(
    1,
    JSON.stringify({
      suppressOutput: true,
      systemMessage,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    })
  );
}

async function fetchLive() {
  const authStore = require('./auth-store');
  const store = require('./store');

  authStore.hydrate();
  const token = authStore.getToken();
  if (!token || !authStore.inspectToken(token).ok) return [];

  const verified = await store.verifyAuthToken(token);
  if (!verified?.valid || !verified?.handle) return [];
  authStore.markVerified(verified.handle);

  return normalizeMessages(await store.getRawInbox(verified.handle));
}

async function main() {
  if (process.argv.includes('--fetch-live')) {
    const messages = await fetchLive().catch(() => []);
    process.stdout.write(JSON.stringify({ messages }));
    return;
  }

  const input = hookInput();
  if (input.hook_event_name !== 'SessionStart' || !['startup', 'resume'].includes(input.source)) {
    emptyOutput();
    return;
  }

  const fixture = fixtureMessages(process.env.VIBE_SESSION_START_FIXTURE);
  hookOutput(fixture === null ? liveMessages() : fixture);
}

if (require.main === module) main().catch(emptyOutput);

module.exports = {
  boundedDeadline,
  emptyOutput,
  hookInput,
  hookOutput,
  main,
  normalizeMessages,
};
