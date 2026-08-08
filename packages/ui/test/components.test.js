import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';
import { fakeQu, flush } from './support/fake-qu.js';

// Must run BEFORE components.js is ever imported (it extends HTMLElement at
// module-evaluation time) - a dynamic import() below, evaluated in program
// order, is what makes that ordering actually hold (a static `import`
// would be hoisted ahead of this call - see testing.js's own doc comment).
installDom();
const { QuViewElement, QuBindElement, QuListElement, QuKeyElement, QuIfElement, findQu } = await import('../src/components.js');

function makeContainer(qu) {
  const el = document.createElement('div');
  el.qu = qu;
  document.body.appendChild(el);
  return el;
}

// ===== findQu ================================================================

test('findQu walks up through parents to find the nearest .qu', () => {
  const qu = fakeQu();
  const outer = document.createElement('div');
  outer.qu = qu;
  const inner = document.createElement('span');
  outer.appendChild(inner);
  assert.equal(findQu(inner), qu);
});

test('findQu returns null when no ancestor has .qu set', () => {
  const el = document.createElement('div');
  assert.equal(findQu(el), null);
});

// ===== <qu-view> ==============================================================

test('<qu-view> renders the current value as textContent by default', async () => {
  const qu = fakeQu({ '/p': 'hello' });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-view path="/p"></qu-view>';
  await flush();
  assert.equal(container.querySelector('qu-view').textContent, 'hello');
});

test('<qu-view> updates live when the watched path changes', async () => {
  const qu = fakeQu({ '/p': 'first' });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-view path="/p"></qu-view>';
  await flush();
  await qu.put('/p', 'second');
  await flush();
  assert.equal(container.querySelector('qu-view').textContent, 'second');
});

test('<qu-view field="..."> reads a property of the object value', async () => {
  const qu = fakeQu({ '/doc': { title: 'Intro' } });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-view path="/doc" field="title"></qu-view>';
  await flush();
  assert.equal(container.querySelector('qu-view').textContent, 'Intro');
});

test('<qu-view> with a single child element targets that child instead of itself', async () => {
  const qu = fakeQu({ '/doc': { mime: 'text/plain' } });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-view path="/doc" field="mime" attr="data-mime"><span></span></qu-view>';
  await flush();
  const span = container.querySelector('span');
  assert.equal(span.getAttribute('data-mime'), 'text/plain');
  assert.equal(container.querySelector('qu-view').textContent, ''); // the wrapper itself is untouched
});

test('<qu-view> wrapping an <input> defaults to reading/writing .value', async () => {
  const qu = fakeQu({ '/doc': 'abc' });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-view path="/doc"><input></qu-view>';
  await flush();
  assert.equal(container.querySelector('input').value, 'abc');
});

test('<qu-view> unsubscribes on disconnect - a later write no longer updates it', async () => {
  const qu = fakeQu({ '/p': 'a' });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-view path="/p"></qu-view>';
  await flush();
  const view = container.querySelector('qu-view');
  view.remove();
  await qu.put('/p', 'b');
  await flush();
  assert.equal(view.textContent, 'a');
});

test('<qu-view> retries once via microtask if no .qu is found yet at connect time', async () => {
  const qu = fakeQu({ '/p': 'late' });
  const container = document.createElement('div'); // .qu not set yet
  document.body.appendChild(container);
  container.innerHTML = '<qu-view path="/p"></qu-view>';
  container.qu = qu; // set right after, same tick - matches the documented ordering caveat
  await flush();
  await flush();
  assert.equal(container.querySelector('qu-view').textContent, 'late');
});

test('<qu-view> with no path attribute and no implicit context path logs an error, does not throw', async () => {
  const qu = fakeQu();
  const container = makeContainer(qu);
  const origError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    container.innerHTML = '<qu-view></qu-view>';
    await flush();
    assert.equal(errors.length, 1);
  } finally {
    console.error = origError;
  }
});

// ===== <qu-bind> ==============================================================

test('<qu-bind> write-back on "input" event calls qu.put with the new value', async () => {
  const qu = fakeQu({ '/doc': 'old' });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-bind path="/doc"><input></qu-bind>';
  await flush();
  const input = container.querySelector('input');
  input.value = 'new';
  input.dispatchEvent(new window.Event('input'));
  await flush();
  assert.equal((await qu.get('/doc')).val, 'new');
});

test('<qu-bind field="..."> write-back is a read-modify-write on the whole document', async () => {
  const qu = fakeQu({ '/doc': { title: 'old', other: 'kept' } });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-bind path="/doc" field="title"><input></qu-bind>';
  await flush();
  const input = container.querySelector('input');
  input.value = 'new';
  input.dispatchEvent(new window.Event('input'));
  await flush();
  assert.deepEqual((await qu.get('/doc')).val, { title: 'new', other: 'kept' });
});

test('<qu-bind attr="checked"> uses the "change" event and boolean get/set', async () => {
  const qu = fakeQu({ '/flag': false });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-bind path="/flag" attr="checked"><input type="checkbox"></qu-bind>';
  await flush();
  const input = container.querySelector('input');
  input.checked = true;
  input.dispatchEvent(new window.Event('change'));
  await flush();
  assert.equal((await qu.get('/flag')).val, true);
});

// ===== <qu-list> ==============================================================

test('<qu-list> stamps one clone per item and shows the right field per item', async () => {
  const qu = fakeQu({
    '/list': [{ path: '/items/a' }, { path: '/items/b' }],
    '/items/a': { title: 'Alpha' },
    '/items/b': { title: 'Beta' },
  });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list path="/list"><template><li><qu-view field="title"></qu-view></li></template></qu-list>';
  await flush();
  const items = [...container.querySelectorAll('li')].map((li) => li.textContent);
  assert.deepEqual(items, ['Alpha', 'Beta']);
});

test('<qu-key> shows the item\'s own path last segment', async () => {
  const qu = fakeQu({
    '/list': [{ path: '/items/alpha-id' }],
    '/items/alpha-id': { title: 'Alpha' },
  });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list path="/list"><template><li><qu-key></qu-key></li></template></qu-list>';
  await flush();
  assert.equal(container.querySelector('li').textContent, 'alpha-id');
});

test('<qu-list> filters out items whose path no longer resolves to anything', async () => {
  const qu = fakeQu({ '/list': [{ path: '/items/a' }, { path: null }] });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list path="/list"><template><li></li></template></qu-list>';
  await flush();
  assert.equal(container.querySelectorAll('li').length, 1);
});

test('<qu-list> re-render reuses the SAME element for an item whose path is unchanged (keyed, not full rebuild)', async () => {
  const qu = fakeQu({
    '/list': [{ path: '/items/a' }],
    '/items/a': { title: 'Alpha' },
  });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list path="/list"><template><li><qu-view field="title"></qu-view></li></template></qu-list>';
  await flush();
  const firstLi = container.querySelector('li');
  firstLi.dataset.marker = 'still-me'; // local DOM state that a rebuild would lose

  await qu.put('/list', [{ path: '/items/a' }, { path: '/items/b' }]);
  await qu.put('/items/b', { title: 'Beta' });
  await flush();

  const lis = [...container.querySelectorAll('li')];
  assert.equal(lis.length, 2);
  assert.equal(lis[0].dataset.marker, 'still-me'); // same element, not a fresh clone
});

test('<qu-list> removes elements for items that dropped out of a later render', async () => {
  const qu = fakeQu({
    '/list': [{ path: '/items/a' }, { path: '/items/b' }],
    '/items/a': { title: 'Alpha' },
    '/items/b': { title: 'Beta' },
  });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list path="/list"><template><li><qu-view field="title"></qu-view></li></template></qu-list>';
  await flush();
  assert.equal(container.querySelectorAll('li').length, 2);

  await qu.put('/list', [{ path: '/items/a' }]);
  await flush();
  const remaining = [...container.querySelectorAll('li')].map((li) => li.textContent);
  assert.deepEqual(remaining, ['Alpha']);
});

test('<qu-list> reorders existing elements to match a new item order', async () => {
  const qu = fakeQu({
    '/list': [{ path: '/items/a' }, { path: '/items/b' }],
    '/items/a': { title: 'Alpha' },
    '/items/b': { title: 'Beta' },
  });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list path="/list"><template><li><qu-view field="title"></qu-view></li></template></qu-list>';
  await flush();

  await qu.put('/list', [{ path: '/items/b' }, { path: '/items/a' }]);
  await flush();
  const order = [...container.querySelectorAll('li')].map((li) => li.textContent);
  assert.deepEqual(order, ['Beta', 'Alpha']);
});

test('<qu-list> missing a <template> child logs an error, does not throw', async () => {
  const qu = fakeQu({ '/list': [] });
  const container = makeContainer(qu);
  const origError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    container.innerHTML = '<qu-list path="/list"></qu-list>';
    await flush();
    // Twice, not once: parsing an element from HTML markup with an
    // attribute ALREADY present fires attributeChangedCallback() for it
    // while isConnected is already true (i.e. BEFORE connectedCallback()
    // itself runs) - both call _mount(), and since there's no state to
    // dedupe an identical "still no <template>" failure against, both log.
    // Documented, pre-existing behavior (see the class's own doc comment),
    // not something this test works around.
    assert.equal(errors.length, 2);
  } finally {
    console.error = origError;
  }
});

// ===== <qu-if> ================================================================

test('<qu-if> hides its children when the watched value is falsy', async () => {
  const qu = fakeQu({ '/flag': false });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-if path="/flag"><span>shown</span></qu-if>';
  await flush();
  assert.equal(container.querySelector('qu-if').hidden, true);
});

test('<qu-if> shows its children when the watched value is truthy, live', async () => {
  const qu = fakeQu({ '/flag': false });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-if path="/flag"><span>shown</span></qu-if>';
  await flush();
  await qu.put('/flag', true);
  await flush();
  assert.equal(container.querySelector('qu-if').hidden, false);
});

test('<qu-if equals="x"> shows only on an exact string match', async () => {
  const qu = fakeQu({ '/status': 'draft' });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-if path="/status" equals="published"></qu-if>';
  await flush();
  assert.equal(container.querySelector('qu-if').hidden, true);
  await qu.put('/status', 'published');
  await flush();
  assert.equal(container.querySelector('qu-if').hidden, false);
});

test('<qu-if negate> inverts the truthy/falsy decision', async () => {
  const qu = fakeQu({ '/flag': true });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-if path="/flag" negate></qu-if>';
  await flush();
  assert.equal(container.querySelector('qu-if').hidden, true);
});

// ===== <qu-list parent="..."> (derived lists) ================================

test('<qu-list parent="..."> renders every direct child, live', async () => {
  const qu = fakeQu({ '/list/a': { title: 'Alpha' }, '/list/b': { title: 'Beta' } });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list parent="/list"><template><li><qu-view field="title"></qu-view></li></template></qu-list>';
  await flush();
  const titles = [...container.querySelectorAll('li')].map((li) => li.textContent).sort();
  assert.deepEqual(titles, ['Alpha', 'Beta']);
});

test('<qu-list parent="..."> picks up a new child written after mount', async () => {
  const qu = fakeQu({ '/list/a': { title: 'Alpha' } });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list parent="/list"><template><li><qu-view field="title"></qu-view></li></template></qu-list>';
  await flush();
  await qu.put('/list/b', { title: 'Beta' });
  await flush();
  const titles = [...container.querySelectorAll('li')].map((li) => li.textContent).sort();
  assert.deepEqual(titles, ['Alpha', 'Beta']);
});

test('<qu-list parent="..."> excludes a tombstoned (val: null) child', async () => {
  const qu = fakeQu({ '/list/a': { title: 'Alpha' }, '/list/b': { title: 'Beta' } });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list parent="/list"><template><li><qu-view field="title"></qu-view></li></template></qu-list>';
  await flush();
  await qu.put('/list/b', null); // clears it, same tombstone convention every derived-list Service uses
  await flush();
  const titles = [...container.querySelectorAll('li')].map((li) => li.textContent);
  assert.deepEqual(titles, ['Alpha']);
});

test('<qu-list parent="..."> removes an element when its child is later tombstoned', async () => {
  const qu = fakeQu({ '/list/a': { title: 'Alpha' } });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list parent="/list"><template><li></li></template></qu-list>';
  await flush();
  assert.equal(container.querySelectorAll('li').length, 1);
  await qu.put('/list/a', null);
  await flush();
  assert.equal(container.querySelectorAll('li').length, 0);
});

// ===== .relatedPaths / related="..." =========================================

test('.relatedPaths resolves a named path from the item\'s own id, readable via related="name"', async () => {
  const qu = fakeQu({
    '/entries/pub1': { visible: true },
    '/profiles/pub1': { alias: 'Ada' },
  });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list parent="/entries"><template><li><qu-view related="profile" field="alias"></qu-view></li></template></qu-list>';
  const list = container.querySelector('qu-list');
  list.relatedPaths = (id) => ({ profile: `/profiles/${id}` });
  // relatedPaths must be set before the list's own _mount() has already
  // stamped items without it - re-triggering by re-setting the parent
  // attribute isn't needed here since innerHTML parsing + property
  // assignment above both happen before the first microtask flush below.
  await flush();

  assert.equal(container.querySelector('li').textContent, 'Ada');
});

test('related="name" not present in relatedPaths logs an error, does not throw', async () => {
  const qu = fakeQu({ '/entries/pub1': { visible: true } });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list parent="/entries"><template><li><qu-view related="nonexistent"></qu-view></li></template></qu-list>';
  const list = container.querySelector('qu-list');
  list.relatedPaths = () => ({});

  const origError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    await flush();
    // Twice, not once - same "parsed from markup with an attribute already
    // present" double-mount as documented on the "<qu-list> missing a
    // <template>" test above: a template-cloned element carries its
    // `related` attribute already set at insertion time, so both
    // connectedCallback() and attributeChangedCallback() fire _mount().
    assert.equal(errors.length, 2);
  } finally {
    console.error = origError;
  }
});

test('without .relatedPaths set, related="..." logs an error rather than silently rendering nothing meaningful', async () => {
  const qu = fakeQu({ '/entries/pub1': { visible: true } });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list parent="/entries"><template><li><qu-view related="profile"></qu-view></li></template></qu-list>';

  const origError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    await flush();
    assert.equal(errors.length, 2); // same double-mount reasoning as the test above
  } finally {
    console.error = origError;
  }
});

test('<qu-if related="..."> resolves through relatedPaths too', async () => {
  const qu = fakeQu({
    '/entries/pub1': { visible: true },
    '/profiles/pub1': { verified: true },
  });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list parent="/entries"><template><li><qu-if related="profile" field="verified">shown</qu-if></li></template></qu-list>';
  const list = container.querySelector('qu-list');
  list.relatedPaths = (id) => ({ profile: `/profiles/${id}` });
  await flush();

  assert.equal(container.querySelector('qu-if').hidden, false);
});

// ===== .onItemStamped ==========================================================

test('.onItemStamped is called once per newly stamped item with its elements, id, and raw item', async () => {
  const qu = fakeQu({ '/list/a': { title: 'Alpha' }, '/list/b': { title: 'Beta' } });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list parent="/list"><template><li></li></template></qu-list>';
  const list = container.querySelector('qu-list');
  const calls = [];
  list.onItemStamped = (els, itemId, item) => calls.push({ itemId, path: item.path, elCount: els.length });
  await flush();

  const byId = Object.fromEntries(calls.map((c) => [c.itemId, c]));
  assert.deepEqual(Object.keys(byId).sort(), ['a', 'b']);
  assert.equal(byId.a.path, '/list/a');
  assert.equal(byId.a.elCount, 1);
});

test('.onItemStamped can mount an imperative element into a slot inside the stamped clone', async () => {
  const qu = fakeQu({ '/list/a': { title: 'Alpha' } });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list parent="/list"><template><li><span class="slot"></span></li></template></qu-list>';
  const list = container.querySelector('qu-list');
  list.onItemStamped = (els) => {
    const slot = els[0].querySelector('.slot');
    const button = document.createElement('button');
    button.textContent = 'mounted';
    slot.replaceWith(button);
  };
  await flush();

  assert.equal(container.querySelector('button').textContent, 'mounted');
});

test('.onItemStamped is NOT called again for an item that re-renders in place (same path, keyed reuse)', async () => {
  const qu = fakeQu({ '/list/a': { title: 'Alpha' } });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list parent="/list"><template><li></li></template></qu-list>';
  const list = container.querySelector('qu-list');
  let calls = 0;
  list.onItemStamped = () => { calls++; };
  await flush();
  assert.equal(calls, 1);

  await qu.put('/list/a', { title: 'Alpha renamed' }); // same path, different value - keyed reuse, no re-stamp
  await flush();
  assert.equal(calls, 1);
});

test('.onItemStamped can give a specific descendant its OWN .qu, distinct from the item context', async () => {
  const qu = fakeQu({ '/list/a': { title: 'Alpha' } });
  const otherQu = fakeQu({ '/other/a': 'from another store' });
  const container = makeContainer(qu);
  container.innerHTML = '<qu-list parent="/list"><template><li><span class="normal"><qu-view field="title"></qu-view></span><span class="special"><qu-view path="/other/a"></qu-view></span></template></qu-list>';
  const list = container.querySelector('qu-list');
  list.onItemStamped = (els) => {
    els[0].querySelector('.special').qu = otherQu;
  };
  await flush();

  assert.equal(container.querySelector('.normal').textContent, 'Alpha');
  assert.equal(container.querySelector('.special').textContent, 'from another store');
});
