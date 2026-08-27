'use strict';

// First-presentation evidence belongs to the actual surface boundary, never
// to a fetch. This symbol carries message ids through the in-process tool
// result without serializing them into MCP content or Platform payloads.
const PRESENTATION_IDS = Symbol.for('slashvibe.presentationMessageIds');

function normalizePresentationIds(values) {
  return [...new Set((values || []).filter((id) => typeof id === 'string' && id.trim()))];
}

function incomingPresentationIds(messages, recipientHandle) {
  const me = String(recipientHandle || '').replace(/^@/, '').toLowerCase();
  return normalizePresentationIds((messages || [])
    .filter((message) => {
      const from = String(message?.from || '').replace(/^@/, '').toLowerCase();
      return from && (!me || from !== me);
    })
    .map((message) => message.presentationId || message.id));
}

function getPresentationIds(value) {
  return normalizePresentationIds(value?.[PRESENTATION_IDS]);
}

function attachPresentationIds(value, ...idLists) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const ids = normalizePresentationIds([
    ...getPresentationIds(value),
    ...idLists.flatMap((list) => normalizePresentationIds(list)),
  ]);
  if (ids.length === 0) return value;
  Object.defineProperty(value, PRESENTATION_IDS, {
    configurable: true,
    enumerable: false,
    value: ids,
  });
  return value;
}

/**
 * Write one MCP response, then record first presentation only after the bytes
 * have crossed the renderer's stdout boundary. The symbol is non-enumerable,
 * so no internal receipt metadata enters model context.
 */
function writeResponseWithPresentation(stream, response, markPresented) {
  const ids = getPresentationIds(response);
  const payload = JSON.stringify(response) + '\n';
  return stream.write(payload, () => {
    if (ids.length === 0 || typeof markPresented !== 'function') return;
    try {
      Promise.resolve(markPresented(ids)).catch(() => {});
    } catch {
      // Presentation already happened. Receipt failure must never turn a
      // successfully rendered message into a client failure.
    }
  });
}

function renderAmbientPresentation(baseText, guestMessages, newDmThreads, renderIncoming) {
  let text = baseText;
  text += renderIncoming(
    (guestMessages || []).map((message) => ({ from: message.from, text: message.message })),
    { replyTo: guestMessages?.[0]?.from, threadHint: false }
  );
  text += renderIncoming(
    (newDmThreads || []).map((thread) => ({
      from: thread.handle,
      text: thread.lastMessage + (thread.unread > 1 ? ` (+${thread.unread - 1} more unread)` : ''),
    })),
    { replyTo: newDmThreads?.[0]?.handle, threadHint: true }
  );
  return {
    text,
    presentationIds: normalizePresentationIds(
      (newDmThreads || []).map((thread) => thread.lastMessageId)
    ),
  };
}

module.exports = {
  PRESENTATION_IDS,
  attachPresentationIds,
  getPresentationIds,
  incomingPresentationIds,
  normalizePresentationIds,
  renderAmbientPresentation,
  writeResponseWithPresentation,
};
