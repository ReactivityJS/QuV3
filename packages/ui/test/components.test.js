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
