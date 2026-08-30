/**
 * vibe call — the explicit live-escalation verb.
 *
 * Call is a HANDOFF, never a summon: this tool only drafts the room line for
 * the human to approve and send through vibe_dm/vibe_reply. Nothing joins,
 * rings, or notifies anyone. The wire may carry the approved room address and
 * the approved result — never room media or hidden context (epic #329 law).
 */

const capabilities = require('../capabilities');

const FRONT_DOOR = 'https://calljimmy.ai';

const definition = {
  name: 'vibe_call',
  description:
    'Draft an explicit live-call handoff for a /vibe conversation — used when text is not enough. Produces the room line for the HUMAN to approve and send with vibe_dm; never sends, joins, or notifies by itself.',
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'Who the call is with (the other participant’s /vibe handle).',
      },
      room: {
        type: 'string',
        maxLength: 200,
        description: 'Optional: an existing room code or URL. Omitted: the calljimmy.ai front door carries the meeting.',
        pattern: '^[A-Za-z0-9:/._?#=-]*$',
      },
    },
    required: ['handle'],
    additionalProperties: false,
  },
};

async function handler(args) {
  const cap = capabilities.manifest().call;
  if (cap.state !== 'available') {
    return {
      display: `call — ${cap.state} · ${cap.why}`,
      data: { silence: true, capability: cap },
    };
  }
  const handle = String(args.handle || '').replace(/^@/, '');
  // The dispatcher does not enforce inputSchema patterns; the handler must
  // (review P1: raw JSON-RPC could smuggle newlines/prose into the draft).
  const ROOM_OK = /^[A-Za-z0-9:/._?#=-]{1,200}$/;
  // '' behaves like omission (the schema permits it; the front door carries it)
  if (args.room !== undefined && args.room !== '' && !ROOM_OK.test(String(args.room))) {
    return {
      display: 'call — that room address contains characters a room address cannot: nothing drafted',
      data: { silence: true, refused: 'invalid_room' },
    };
  }
  const room = args.room ? String(args.room) : FRONT_DOOR;
  const line = room.startsWith('http')
    ? `let's talk this through live — ${room}`
    : `let's talk this through live — /join-call ${room}`;
  return {
    display:
      `**call handoff drafted** (nothing sent — your words, your send)\n` +
      `to @${handle}: “${line}”\n` +
      `approve and send with vibe_dm, or discard. joining stays a human act on both sides.`,
    data: { draft: line, to: handle, sent: false },
  };
}

module.exports = { definition, handler };
