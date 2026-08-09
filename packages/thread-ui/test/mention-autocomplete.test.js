import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mountMentionAutocomplete } = await import('../src/mention-autocomplete.js');

const ADA_PUB = 'adaadaada1234567890abcdefghijk';
const BOB_PUB = 'bobbob1234567890xyzxyzxyzxyzxy';
const NOALIAS_PUB = 'zzzzzz1234567890noaliasnoalias';

function fakeServices() {
  return {
    directory: {
      async listVisible() {
        return [{ actorPub: ADA_PUB }, { actorPub: NOALIAS_PUB }];
      },
    },
    contacts: {
      async listContacts() {
        return [{ actorPub: BOB_PUB, profile: { alias: 'Bob' } }, { actorPub: ADA_PUB, profile: { alias: 'Ada' } }]; // ADA also a contact - must not appear twice
      },
    },
    profile: {
      async getPublicProfile(pub) {
        if (pub === ADA_PUB) return { alias: 'Ada' };
        return null; // NOALIAS_PUB has no published alias
      },
    },
  };
}

function makeTextarea() {
  const el = document.createElement('textarea');
  document.body.appendChild(el);
  return el;
}

function type(el, value, caret = value.length) {
  el.value = value;
  el.selectionStart = el.selectionEnd = caret;
  el.dispatchEvent(new CustomEvent('input', { bubbles: true }));
}

test('one typed character after @ does not open the dropdown', async () => {
  const el = makeTextarea();
  const stop = mountMentionAutocomplete(el, { services: fakeServices() });
  try {
    type(el, 'hi @a');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.querySelector('.qu-thread-ui-mention-list'), null);
  } finally {
    stop();
  }
});

test('two typed characters after @ opens the dropdown, matching by alias prefix', async () => {
  const el = makeTextarea();
  const stop = mountMentionAutocomplete(el, { services: fakeServices() });
  try {
    type(el, 'hi @ad');
    await waitFor(() => document.querySelector('.qu-thread-ui-mention-list') !== null);
    const items = [...document.querySelectorAll('.qu-thread-ui-mention-item')];
    assert.equal(items.length, 1);
    assert.ok(items[0].textContent.includes('Ada'));
  } finally {
    stop();
  }
});

test('matches by pub prefix for an actor with no published alias', async () => {
  const el = makeTextarea();
  const stop = mountMentionAutocomplete(el, { services: fakeServices() });
  try {
    type(el, `hi @${NOALIAS_PUB.slice(0, 4)}`);
    await waitFor(() => document.querySelector('.qu-thread-ui-mention-list') !== null);
    const items = [...document.querySelectorAll('.qu-thread-ui-mention-item')];
    assert.equal(items.length, 1);
    assert.ok(items[0].textContent.includes(NOALIAS_PUB.slice(0, 10)));
  } finally {
    stop();
  }
});

test('an actor present in both directory and contacts is only listed once', async () => {
  const el = makeTextarea();
  const stop = mountMentionAutocomplete(el, { services: fakeServices() });
  try {
    type(el, 'hi @a'); // 1 char - not enough yet
    type(el, 'hi @ad');
    await waitFor(() => document.querySelector('.qu-thread-ui-mention-list') !== null);
    const items = document.querySelectorAll('.qu-thread-ui-mention-item');
    assert.equal(items.length, 1); // Ada, deduplicated - not once per source
  } finally {
    stop();
  }
});

test('selecting a candidate replaces the typed fragment with @<fullPub> and closes the dropdown', async () => {
  const el = makeTextarea();
  const stop = mountMentionAutocomplete(el, { services: fakeServices() });
  try {
    type(el, 'hi @ad, how are you');
    el.selectionStart = el.selectionEnd = 6; // caret right after "@ad"
    el.dispatchEvent(new CustomEvent('input', { bubbles: true }));
    await waitFor(() => document.querySelector('.qu-thread-ui-mention-list') !== null);

    document.querySelector('.qu-thread-ui-mention-item').dispatchEvent(new CustomEvent('mousedown', { bubbles: true, cancelable: true }));

    assert.equal(el.value, `hi @${ADA_PUB}, how are you`);
    assert.equal(document.querySelector('.qu-thread-ui-mention-list'), null);
  } finally {
    stop();
  }
});

test('no match narrows the dropdown to nothing and closes it', async () => {
  const el = makeTextarea();
  const stop = mountMentionAutocomplete(el, { services: fakeServices() });
  try {
    type(el, 'hi @ad');
    await waitFor(() => document.querySelector('.qu-thread-ui-mention-list') !== null);
    type(el, 'hi @adzzzzznomatch');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.querySelector('.qu-thread-ui-mention-list'), null);
  } finally {
    stop();
  }
});

test('stop() removes listeners and closes any open dropdown', async () => {
  const el = makeTextarea();
  const stop = mountMentionAutocomplete(el, { services: fakeServices() });
  type(el, 'hi @ad');
  await waitFor(() => document.querySelector('.qu-thread-ui-mention-list') !== null);
  stop();
  assert.equal(document.querySelector('.qu-thread-ui-mention-list'), null);
  type(el, 'hi @ad more'); // must not reopen after stop()
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(document.querySelector('.qu-thread-ui-mention-list'), null);
});
