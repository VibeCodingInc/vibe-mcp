/**
 * vibe mind — private pre-send thinking pass.
 *
 * This tool never sends. Exact user-provided messages bypass it and continue
 * through vibe_dm / vibe_reply unchanged.
 */

const path = require('node:path');
const personalMind = require('../personal-mind');

const definition = {
  name: 'vibe_mind',
  description: 'Privately consult the user’s own Personal Mind while drafting a consequential /vibe message. Use before proposing prose when the user is still thinking; never use for an exact send they already approved. This tool never sends. Show its one sourced offer (or silence) and wait for explicit approve/edit/discard before calling vibe_dm or vibe_reply.',
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'The intended recipient handle. Used only by the private edge Mind.',
      },
      draft: {
        type: 'string',
        maxLength: 4000,
        description: 'The unsent active draft, unchanged. Maximum 4,000 UTF-8 bytes.',
      },
      recent_messages: {
        type: 'array',
        maxItems: 8,
        description: 'Up to the eight most recent messages already visible in this thread. The native boundary caps the encoded context at 2,000 UTF-8 bytes.',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['from', 'text'],
          additionalProperties: false,
        },
      },
    },
    required: ['handle', 'draft'],
    additionalProperties: false,
  },
};

function sourceLine(facet) {
  const privateDetail = facet?.aperture?.shown_to_owner_only
    || facet?.aperture?.shown_to_seth_only;
  const source = privateDetail?.source || facet?.source;
  const date = privateDetail?.freshness || facet?.content_date;
  const leaf = source ? path.basename(source) : null;
  if (!leaf) return null;
  return `from ${leaf}${date ? ` · ${date}` : ''}`;
}

async function handler(args) {
  const result = await personalMind.ask({
    handle: args?.handle,
    draft: args?.draft,
    recentMessages: args?.recent_messages,
  });

  if (result.error === 'draft_too_large') {
    return { display: 'Private Mind stayed off — this draft exceeds the approved 4,000-byte boundary. Nothing was sent.' };
  }
  if (result.error) {
    return { display: 'Private Mind is unavailable. Nothing was sent; continue with the human’s draft.' };
  }
  if (result.silence) {
    return { display: 'Private Mind stayed quiet. Nothing was sent; continue with the human’s draft.' };
  }

  const facet = result.facet;
  const privateDetail = facet?.aperture?.shown_to_owner_only
    || facet?.aperture?.shown_to_seth_only;
  const insight = facet.proposed_prose || facet.facet || privateDetail?.exact_words;
  const source = sourceLine(facet);
  if (!insight || !source) {
    return { display: 'Private Mind stayed quiet. Nothing was sent; continue with the human’s draft.' };
  }
  const attribution = facet.attribution || facet.author_class;
  const caveat = facet.caveat || facet.labeled_inference || facet.disclosure_reason;
  const lines = [
    `Private Mind · ${source} · see`,
    `\n${insight}`,
    attribution ? `\nsource voice: ${attribution}` : '',
    caveat ? `\ncaveat: ${caveat}` : '',
    '\nNothing was sent. Show this offer to the human and wait for approve, edit, or discard.',
  ];
  return { display: lines.filter(Boolean).join('') };
}

module.exports = { definition, handler, sourceLine };
