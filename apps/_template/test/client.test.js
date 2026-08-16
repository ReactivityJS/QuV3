import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ActorService } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount, renderHeaderNavPoints } = await import('../client.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const services = { actors: new ActorService(identity) };
  return { qu, identity, services };
}

/** Must be attached to document.body - reactive rendering only matters once actually part of the document. */
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// ===== Folder view (Rule 3 - Context Switcher) =============================

test('#/template defaults to the first folder (Inbox), listing its notes and the folder switcher', async () => {
  const { services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { services, segments: ['template'] });
  try {
    await waitFor(() => container.querySelector('.qu-template-notes a') !== null);
    assert.equal(container.querySelector('.qu-template-notes a').textContent, 'Welcome');
    const items = [...container.querySelectorAll('.qu-ctxswitch-list a')].map((a) => a.textContent);
    assert.deepEqual(items, ['Inbox', 'Ideas', 'Archive']);
    assert.ok(container.querySelector('.qu-ctxswitch-list a.qu-ctxswitch-item-active').textContent, 'Inbox');
  } finally {
    stop();
  }
});

test('#/template/f/<folderId> switches folders and shows that folder\'s own empty state', async () => {
  const { services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { services, segments: ['template', 'f', 'ideas'] });
  try {
    await waitFor(() => container.querySelector('.qu-template-empty') !== null);
    assert.equal(container.querySelector('.qu-template-empty').textContent, 'No notes in this folder yet.');
  } finally {
    stop();
  }
});

// ===== Note detail + create (Rule 1 - no bespoke back link) ================

test('#/template/n/<noteId> shows the note, with no back link of its own', async () => {
  const { services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { services, segments: ['template', 'n', 'welcome'] });
  try {
    await waitFor(() => container.querySelector('h1') !== null);
    assert.equal(container.querySelector('h1').textContent, 'Welcome');
    assert.equal(container.querySelector('a.qu-subpage-back'), null);
  } finally {
    stop();
  }
});

test('#/template/n/<unknown> shows the "not found" message instead of throwing', async () => {
  const { services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { services, segments: ['template', 'n', 'does-not-exist'] });
  try {
    await waitFor(() => container.textContent.includes('This note no longer exists.'));
  } finally {
    stop();
  }
});

test('creating a note via #/template/new navigates to its own detail page', async () => {
  const { services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { services, segments: ['template', 'new'] });
  try {
    await waitFor(() => container.querySelector('.qu-template-form') !== null);
    assert.equal(container.querySelector('a.qu-subpage-back'), null);
    container.querySelector('input[type="text"]').value = 'A brand new note';
    container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => window.location.hash.startsWith('#/template/n/'));
  } finally {
    stop();
    window.location.hash = '';
  }
});

// ===== renderHeaderNavPoints() - the shell.headerNavPoints contributor (Rule 2) ==

test('renderHeaderNavPoints(): hidden while another app is active, shows a "New note" link once this app becomes active', () => {
  const container = makeContainer();
  let appId = 'chat';
  const listeners = [];
  renderHeaderNavPoints(container, {
    getContext: () => ({ appId, segments: [appId] }),
    onContextChange: (cb) => listeners.push(cb),
  });
  const wrap = container.querySelector('.qu-app-header-action');
  assert.equal(wrap.hidden, true);

  appId = 'template';
  listeners.forEach((cb) => cb());
  assert.equal(wrap.hidden, false);
  const link = wrap.querySelector('a');
  assert.equal(link.getAttribute('href'), '#/template/new');
  assert.equal(link.title, 'New note');
  assert.equal(link.getAttribute('aria-label'), 'New note');
});
