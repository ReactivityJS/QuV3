import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, ReactionService } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { renderReactionWidget, renderEntityReactionWidget } = await import('../client.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const list = new ListService(qu);
  const services = { reactions: new ReactionService(qu, identity, list) };
  const myPub = (await identity.getMainKey()).publicKey;
  const { QuCrypto } = await import('@qu/core');
  return { qu, services, myPub: QuCrypto.toBase64Url(myPub) };
}

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function basePayload({ qu, services, myPub }) {
  return { services, qu, spaceId: 'forum-space', threadId: 'topic1', messageId: 'msg1', myPub };
}

test('a message with no reactions yet shows only the trigger, no pills', async () => {
  const env = await freshEnv();
  const container = makeContainer();
  await renderReactionWidget(container, basePayload(env));
  await waitFor(() => container.querySelector('.qu-reactions-row') !== null);
  assert.equal(container.querySelectorAll('.qu-reactions-pill').length, 0);
  assert.ok(container.querySelector('.qu-thread-ui-emoji-trigger'));
});

test('reacting via the picker renders a pill with a count of 1, highlighted as mine', async () => {
  const env = await freshEnv();
  const container = makeContainer();
  await renderReactionWidget(container, basePayload(env));
  await waitFor(() => container.querySelector('.qu-thread-ui-emoji-trigger') !== null);

  container.querySelector('.qu-thread-ui-emoji-trigger').click();
  await waitFor(() => container.querySelector('.qu-thread-ui-emoji-panel') !== null);
  container.querySelector('.qu-thread-ui-emoji-panel button').click();

  await waitFor(() => container.querySelector('.qu-reactions-pill') !== null);
  const pill = container.querySelector('.qu-reactions-pill');
  assert.match(pill.textContent, /1$/);
  assert.ok(pill.classList.contains('qu-reactions-pill-mine'));
});

test('clicking my own reaction pill again clears it', async () => {
  const env = await freshEnv();
  // Set directly via the service first (matching basePayload()'s spaceId/threadId/messageId) so the pill is already there on mount.
  await env.services.reactions.setReaction('forum-space', 'topic1', 'msg1', '🔥');

  const container = makeContainer();
  await renderReactionWidget(container, basePayload(env));
  await waitFor(() => container.querySelector('.qu-reactions-pill') !== null);
  assert.equal(container.querySelector('.qu-reactions-pill').textContent, '🔥 1');

  container.querySelector('.qu-reactions-pill').click();
  await waitFor(() => container.querySelector('.qu-reactions-pill') === null);
  assert.deepEqual(await env.services.reactions.getReactions('forum-space', 'topic1', 'msg1'), {});
});

test('a reaction set elsewhere in the SAME store appears live in an already-mounted widget', async () => {
  const env = await freshEnv();
  const container = makeContainer();
  await renderReactionWidget(container, basePayload(env));
  await waitFor(() => container.querySelector('.qu-reactions-row') !== null);
  assert.equal(container.querySelectorAll('.qu-reactions-pill').length, 0);

  await env.services.reactions.setReaction('forum-space', 'topic1', 'msg1', '👍');
  await waitFor(() => container.querySelector('.qu-reactions-pill') !== null);
  assert.equal(container.querySelector('.qu-reactions-pill').textContent, '👍 1');
});

test('the trigger uses the "😀" glyph, not a bare "+" or an actual reaction choice - see this app\'s own "TRIGGER GLYPH" doc comment', async () => {
  const env = await freshEnv();
  const container = makeContainer();
  await renderReactionWidget(container, basePayload(env));
  await waitFor(() => container.querySelector('.qu-thread-ui-emoji-trigger') !== null);
  assert.equal(container.querySelector('.qu-thread-ui-emoji-trigger').textContent, '😀');
});

test('disconnecting the widget from the DOM tears down its live subscription (no error, no further updates)', async () => {
  const env = await freshEnv();
  const container = makeContainer();
  await renderReactionWidget(container, basePayload(env));
  await waitFor(() => container.querySelector('.qu-reactions-row') !== null);

  container.remove();
  await assert.doesNotReject(() => env.services.reactions.setReaction('forum-space', 'topic1', 'msg1', '👍'));
});

// ===== renderEntityReactionWidget() - content.entityFooter ================

function entityPayload({ qu, services, myPub }) {
  return { services, qu, spaceId: 'forum-space', entityId: 'topic1', myPub };
}

test('renderEntityReactionWidget(): reacting via the picker renders a pill, using the entity-scoped service methods', async () => {
  const env = await freshEnv();
  const container = makeContainer();
  await renderEntityReactionWidget(container, entityPayload(env));
  await waitFor(() => container.querySelector('.qu-thread-ui-emoji-trigger') !== null);

  container.querySelector('.qu-thread-ui-emoji-trigger').click();
  await waitFor(() => container.querySelector('.qu-thread-ui-emoji-panel') !== null);
  container.querySelector('.qu-thread-ui-emoji-panel button').click();

  await waitFor(() => container.querySelector('.qu-reactions-pill') !== null);
  assert.ok(container.querySelector('.qu-reactions-pill').classList.contains('qu-reactions-pill-mine'));
  const stored = await env.services.reactions.getEntityReactions('forum-space', 'topic1');
  assert.equal(Object.values(stored).flat().length, 1);
});

test('renderEntityReactionWidget(): an entity reaction and a message reaction at the SAME id never mix', async () => {
  const env = await freshEnv();
  await env.services.reactions.setReaction('forum-space', 'topic1', 'msg1', '🔥'); // message-scoped, same threadId/id coincidentally

  const container = makeContainer();
  await renderEntityReactionWidget(container, entityPayload(env));
  await waitFor(() => container.querySelector('.qu-reactions-row') !== null);
  assert.equal(container.querySelectorAll('.qu-reactions-pill').length, 0); // the message-scoped reaction above must not leak in
});
