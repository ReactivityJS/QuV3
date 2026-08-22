import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { mountContentEditor } = await import('../src/content-editor.js');
const { locationExtension } = await import('../src/location-extension.js');

function makeHost() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// Same pattern as apps/chat/test/client.test.js's own installGeolocationMock().
function installGeolocationMock(coords = { latitude: 52.52, longitude: 13.405 }) {
  navigator.geolocation = { getCurrentPosition: (success) => success({ coords }) };
}
function installDeniedGeolocationMock() {
  navigator.geolocation = { getCurrentPosition: (_success, error) => error(new Error('denied')) };
}

function triggerBtn(host) {
  return host.querySelector('.qu-content-editor-leading button');
}

test('registers a 📍 trigger', () => {
  const host = makeHost();
  mountContentEditor(host, { extensions: [locationExtension()] });
  assert.equal(triggerBtn(host).textContent, '📍');
});

test('clicking the trigger contributes the resolved position and renders a removable chip', () => {
  installGeolocationMock();
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [locationExtension()] });
  const submitted = [];
  editor.onSubmit((text, extras) => submitted.push(extras));

  triggerBtn(host).click();
  assert.ok(host.querySelector('.qu-content-ui-location-chip'));

  host.querySelector('.qu-content-editor-submit-slot button').click();
  assert.deepEqual(submitted[0].location, { lat: 52.52, lng: 13.405 });
});

test('a denied/unavailable position degrades to a no-op, not a throw', () => {
  installDeniedGeolocationMock();
  const host = makeHost();
  assert.doesNotThrow(() => {
    mountContentEditor(host, { extensions: [locationExtension()] });
    triggerBtn(host).click();
  });
  assert.equal(host.querySelector('.qu-content-ui-location-chip'), null);
});

test('missing navigator.geolocation degrades to a no-op', () => {
  navigator.geolocation = undefined;
  const host = makeHost();
  assert.doesNotThrow(() => {
    mountContentEditor(host, { extensions: [locationExtension()] });
    triggerBtn(host).click();
  });
});

test('removing the chip retracts the contribution', () => {
  installGeolocationMock();
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [locationExtension()] });
  const submitted = [];
  editor.onSubmit((text, extras) => submitted.push(extras));

  triggerBtn(host).click();
  host.querySelector('.qu-content-ui-location-chip button').click();
  assert.equal(host.querySelector('.qu-content-ui-location-chip'), null);

  host.querySelector('.qu-content-editor-submit-slot button').click();
  assert.deepEqual(submitted, []);
});

test('stop() cleans up the trigger and any pending contribution', () => {
  installGeolocationMock();
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [locationExtension()] });
  triggerBtn(host).click();

  editor.stop();
  assert.equal(triggerBtn(host), null);
});
