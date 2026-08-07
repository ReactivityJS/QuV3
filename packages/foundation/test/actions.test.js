import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionsForSlot, resolveActionHref } from '../src/actions.js';

const apps = [
  {
    name: 'chat',
    actions: [
      { slot: 'contact-row', id: 'chat', label: '💬 Chat', hrefTemplate: '#/chat/{pub}', order: 5 },
    ],
  },
  {
    name: 'geochase',
    actions: [
      { slot: 'contact-row', id: 'invite', label: '🎯 Invite', hrefTemplate: '#/geochase/invite/{pub}' }, // no order -> 0
      { slot: 'other-slot', id: 'ignored', label: 'x', hrefTemplate: '#/x' },
    ],
  },
  { name: 'no-actions-app' }, // actions field entirely absent
];

test('actionsForSlot() collects only actions declared for the requested slot', () => {
  const result = actionsForSlot(apps, 'contact-row');
  assert.deepEqual(
    result.map((a) => a.id),
    ['invite', 'chat'] // order 0 before order 5
  );
});

test('actionsForSlot() sorts by order ascending, defaulting missing order to 0', () => {
  const result = actionsForSlot(apps, 'contact-row');
  assert.equal(result[0].id, 'invite'); // order 0
  assert.equal(result[1].id, 'chat'); // order 5
});

test('actionsForSlot() returns an empty array for a slot nobody contributes to', () => {
  assert.deepEqual(actionsForSlot(apps, 'nowhere'), []);
});

test('actionsForSlot() tolerates apps with no `actions` field and a missing/undefined catalog', () => {
  assert.deepEqual(actionsForSlot([{ name: 'x' }], 'contact-row'), []);
  assert.deepEqual(actionsForSlot(undefined, 'contact-row'), []);
});

test('actionsForSlot() result carries appId, icon defaulting to null, and no leaked `order`/`slot` fields', () => {
  const [invite] = actionsForSlot(apps, 'contact-row');
  assert.deepEqual(Object.keys(invite).sort(), ['appId', 'hrefTemplate', 'icon', 'id', 'label'].sort());
  assert.equal(invite.appId, 'geochase');
  assert.equal(invite.icon, null);
});

test('resolveActionHref() fills in {param} tokens and URL-encodes each value', () => {
  const action = { id: 'chat', hrefTemplate: '#/chat/{pub}' };
  assert.equal(resolveActionHref(action, { pub: 'ab+c/d' }), '#/chat/ab%2Bc%2Fd');
});

test('resolveActionHref() fills multiple distinct tokens in one template', () => {
  const action = { id: 'x', hrefTemplate: '#/calendar/{calendarId}/{eventId}' };
  assert.equal(resolveActionHref(action, { calendarId: 'c1', eventId: 'e1' }), '#/calendar/c1/e1');
});

test('resolveActionHref() throws when a referenced param is missing', () => {
  const action = { id: 'chat', hrefTemplate: '#/chat/{pub}' };
  assert.throws(() => resolveActionHref(action, {}), /needs param "pub"/);
});

test('resolveActionHref() with no {param} tokens returns the template unchanged', () => {
  const action = { id: 'x', hrefTemplate: '#/static-page' };
  assert.equal(resolveActionHref(action, {}), '#/static-page');
});
