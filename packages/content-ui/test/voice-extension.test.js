import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { mountContentEditor } = await import('../src/content-editor.js');
const { voiceExtension } = await import('../src/voice-extension.js');

function makeHost() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// Ported verbatim from apps/chat/test/client.test.js's own FakeMediaRecorder/
// installVoiceMocks() - the exact jsdom test-double pattern for this state machine.
class FakeMediaRecorder {
  constructor() {
    this.mimeType = 'audio/webm';
    this.state = 'inactive';
  }
  start() { this.state = 'recording'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['fake voice bytes'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}
function installVoiceMocks() {
  navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };
  globalThis.MediaRecorder = FakeMediaRecorder;
}

function fakeAssetService(uploadResult = { name: 'voice.webm', mime: 'audio/webm', size: 10 }) {
  return {
    uploadCalls: [],
    async upload(spaceId, assetId, file) {
      this.uploadCalls.push({ spaceId, assetId, file });
      return uploadResult;
    },
  };
}

function triggerBtn(host) {
  return host.querySelector('.qu-content-editor-leading button');
}
function normalRowHidden(host) {
  return host.querySelector('.qu-content-editor-row').hidden;
}
function panel(host) {
  return host.querySelector('.qu-content-ui-voice-recorder');
}

test('registers a 🎙️ leading trigger', () => {
  const host = makeHost();
  mountContentEditor(host, { extensions: [voiceExtension({ assetService: fakeAssetService(), spaceId: 'space1' })] });
  assert.equal(triggerBtn(host).textContent, '🎙️');
});

test('the submit button shows 🎙️ when the composer is empty, and reverts to Send once text is typed', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, {
    extensions: [voiceExtension({ assetService: fakeAssetService(), spaceId: 'space1' })],
    submitLabel: '➤',
  });
  const submitBtn = () => host.querySelector('.qu-content-editor-submit-slot button');

  assert.equal(submitBtn().textContent, '🎙️');
  editor.setValue('hi');
  assert.equal(submitBtn().textContent, '➤');
  editor.setValue('');
  assert.equal(submitBtn().textContent, '🎙️');
});

test('starting a recording (via the leading trigger) swaps the chrome to the recorder panel', async () => {
  installVoiceMocks();
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [voiceExtension({ assetService: fakeAssetService(), spaceId: 'space1' })] });

  triggerBtn(host).click();
  await new Promise((resolve) => setTimeout(resolve, 0)); // getUserMedia() resolves async
  assert.equal(normalRowHidden(host), true);
  assert.ok(panel(host));
  assert.equal(panel(host).querySelector('.qu-content-ui-voice-dot').hidden, false);

  editor.stop(); // discards the still-live recording - see stop()'s own doc comment; leaving the elapsed-time interval running would hang node --test after this file finishes
});

test('starting a recording via the empty-composer submit slot works the same way', async () => {
  installVoiceMocks();
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [voiceExtension({ assetService: fakeAssetService(), spaceId: 'space1' })] });

  host.querySelector('.qu-content-editor-submit-slot button').click(); // shows 🎙️ when empty - click it
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(normalRowHidden(host), true);

  editor.stop();
});

test('pause -> resume -> finish reaches PREVIEW (not an immediate send), with a real <audio> src', async () => {
  installVoiceMocks();
  const host = makeHost();
  mountContentEditor(host, { extensions: [voiceExtension({ assetService: fakeAssetService(), spaceId: 'space1' })] });

  triggerBtn(host).click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const buttons = panel(host).querySelectorAll('button');
  const [discardBtn, pauseBtn, finishBtn, sendBtn] = buttons;
  pauseBtn.click(); // pause
  assert.equal(panel(host).querySelector('.qu-content-ui-voice-dot').hidden, true);
  pauseBtn.click(); // resume
  assert.equal(panel(host).querySelector('.qu-content-ui-voice-dot').hidden, false);

  finishBtn.click(); // FakeMediaRecorder.stop() synchronously fires ondataavailable+onstop -> preview
  const preview = panel(host).querySelector('.qu-content-ui-voice-preview');
  assert.equal(preview.hidden, false);
  assert.ok(preview.src);
  assert.equal(sendBtn.hidden, false);
  assert.equal(finishBtn.hidden, true);
  void discardBtn;
});

test('Send in preview uploads the recording and calls onSubmit via submitNow (independent of typed text)', async () => {
  installVoiceMocks();
  const host = makeHost();
  const service = fakeAssetService({ name: 'voice.webm', mime: 'audio/webm', size: 10 });
  const editor = mountContentEditor(host, { extensions: [voiceExtension({ assetService: service, spaceId: 'space1' })] });
  const submitted = [];
  editor.onSubmit((text, extras) => submitted.push({ text, extras }));

  editor.setValue('an unrelated draft'); // must survive untouched
  triggerBtn(host).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  panel(host).querySelectorAll('button')[2].click(); // finish -> preview
  await panel(host).querySelectorAll('button')[3].click(); // send

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].text, '');
  assert.equal(submitted[0].extras.attachments[0].name, 'voice.webm');
  assert.equal(service.uploadCalls.length, 1);
  assert.equal(editor.getValue(), 'an unrelated draft');
  assert.equal(normalRowHidden(host), false); // chrome restored
});

test('Discard from a live recording returns to the normal composer with nothing sent', async () => {
  installVoiceMocks();
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [voiceExtension({ assetService: fakeAssetService(), spaceId: 'space1' })] });
  const submitted = [];
  editor.onSubmit((text, extras) => submitted.push(extras));

  triggerBtn(host).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  panel(host).querySelectorAll('button')[0].click(); // discard while recording
  assert.equal(normalRowHidden(host), false);
  assert.deepEqual(submitted, []);
});

test('Discard from PREVIEW also returns to the normal composer with nothing sent', async () => {
  installVoiceMocks();
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [voiceExtension({ assetService: fakeAssetService(), spaceId: 'space1' })] });
  const submitted = [];
  editor.onSubmit((text, extras) => submitted.push(extras));

  triggerBtn(host).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  panel(host).querySelectorAll('button')[2].click(); // finish -> preview
  panel(host).querySelectorAll('button')[0].click(); // discard from preview
  assert.equal(normalRowHidden(host), false);
  assert.deepEqual(submitted, []);
});

test('unsupported MediaRecorder/getUserMedia degrades silently - trigger present, click does nothing harmful', () => {
  navigator.mediaDevices = undefined;
  globalThis.MediaRecorder = undefined;
  const host = makeHost();
  mountContentEditor(host, { extensions: [voiceExtension({ assetService: fakeAssetService(), spaceId: 'space1' })] });

  assert.ok(triggerBtn(host));
  assert.doesNotThrow(() => triggerBtn(host).click());
  assert.equal(normalRowHidden(host), false);
});

test('stop() while a recording is active discards it and unregisters the trigger/submit candidate', async () => {
  installVoiceMocks();
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [voiceExtension({ assetService: fakeAssetService(), spaceId: 'space1' })] });

  triggerBtn(host).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  editor.stop();
  assert.equal(triggerBtn(host), null);
});
