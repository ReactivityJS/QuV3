/**
 * VOICE EXTENSION — generalizes `apps/chat/client.js`'s own complete, proven
 * voice-message state machine (Start → Pause ⇄ Resume → Finish → **Preview
 * (real playback) → Send or Discard**, never an immediate send - ported
 * essentially verbatim, see that file's own doc comment near
 * `startRecording()`) into a `ContentEditor` `EditorExtension`.
 *
 * TWO ways to start a recording, both calling the SAME `startRecording()`:
 *   - a `🎙️` trigger in the leading action slot (`ctx.registerAction()`) -
 *     tap it directly, any time.
 *   - a `ctx.registerSubmitCandidate()` entry that only wins (per `@qu/ui`'s
 *     `mountResolvedSlot()` `'switch'` strategy) while the composer is
 *     otherwise completely empty (`!hasText && !hasContribution`) - the
 *     mic-morph, now a normal, general submit-slot candidate instead of a
 *     one-off boundary violation (see `docs/v4-concept.md` §6).
 *
 * While recording/paused/previewing, `ctx.setChrome()` swaps the editor's
 * entire normal row for this extension's own recorder panel (built once,
 * reused across recordings - same "one hidden/shown panel" shape
 * `apps/chat/client.js`'s own `voiceRecorderEl` already uses, not rebuilt
 * per recording). Sending uploads the recorded `Blob` via
 * `assetService.upload()` (same `File`/naming convention
 * `sendVoiceRecording()` already uses) then `ctx.submitNow()`s it -
 * independent of whatever text is currently typed, exactly like the
 * original.
 */

const STYLE_ID = 'qu-content-ui-voice-style';
const STYLE = `
  .qu-content-ui-voice-recorder { display: flex; align-items: center; gap: 0.6rem; }
  .qu-content-ui-voice-dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--qu-color-danger, #d64545); flex-shrink: 0; animation: qu-content-ui-voice-dot-pulse 1.2s ease-in-out infinite; }
  .qu-content-ui-voice-dot[hidden] { display: none; }
  @keyframes qu-content-ui-voice-dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  .qu-content-ui-voice-time { font-variant-numeric: tabular-nums; opacity: 0.8; min-width: 2.6em; }
  .qu-content-ui-voice-time[hidden] { display: none; }
  .qu-content-ui-voice-preview { flex: 1; min-width: 0; height: 2.2rem; }
  .qu-content-ui-voice-preview[hidden] { display: none; }
  .qu-content-ui-voice-recorder button[hidden] { display: none; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function formatVoiceElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/**
 * @param {{assetService: object, spaceId: string|number, readerPubs?: string[], asSpaceId?: string|number, trigger?: string, triggerTitle?: string}} options
 * @returns {{id: string, mount: (ctx: object) => (() => void)}}
 */
export function voiceExtension({ assetService, spaceId, readerPubs, asSpaceId, trigger = '🎙️', triggerTitle = 'Record a voice message' } = {}) {
  return {
    id: 'voice',
    mount(ctx) {
      ensureStyle();

      // ---- panel DOM (built once, reused across recordings) --------------
      const panel = document.createElement('div');
      panel.className = 'qu-content-ui-voice-recorder';
      const discardBtn = document.createElement('button');
      discardBtn.type = 'button';
      discardBtn.textContent = '🗑️';
      discardBtn.title = 'Discard recording';
      const dot = document.createElement('span');
      dot.className = 'qu-content-ui-voice-dot';
      const timeEl = document.createElement('span');
      timeEl.className = 'qu-content-ui-voice-time';
      timeEl.textContent = '00:00';
      const previewPlayer = document.createElement('audio');
      previewPlayer.className = 'qu-content-ui-voice-preview';
      previewPlayer.controls = true;
      const pauseBtn = document.createElement('button');
      pauseBtn.type = 'button';
      const finishBtn = document.createElement('button');
      finishBtn.type = 'button';
      finishBtn.textContent = '⏹';
      finishBtn.title = 'Finish recording';
      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.textContent = '➤';
      sendBtn.title = 'Send';
      panel.append(discardBtn, dot, timeEl, previewPlayer, pauseBtn, finishBtn, sendBtn);

      // ---- state (ported essentially verbatim from apps/chat/client.js) --
      let recorderState = 'idle'; // 'idle' | 'recording' | 'paused' | 'preview'
      let mediaRecorder = null;
      let mediaStream = null;
      let recordedChunks = [];
      let recordedBlob = null;
      let recordedObjectUrl = null;
      let recordingElapsedMs = 0;
      let recordingSpanStartedAt = 0;
      let recordingTimerHandle = null;
      let discardingOnStop = false;

      function currentElapsedMs() {
        return recordingElapsedMs + (recorderState === 'recording' ? Date.now() - recordingSpanStartedAt : 0);
      }
      function startTimer() {
        stopTimer();
        timeEl.textContent = formatVoiceElapsed(currentElapsedMs());
        recordingTimerHandle = setInterval(() => { timeEl.textContent = formatVoiceElapsed(currentElapsedMs()); }, 250);
      }
      function stopTimer() {
        clearInterval(recordingTimerHandle);
        recordingTimerHandle = null;
      }
      function syncUI() {
        const isPreview = recorderState === 'preview';
        dot.hidden = recorderState !== 'recording';
        timeEl.hidden = isPreview;
        previewPlayer.hidden = !isPreview;
        pauseBtn.hidden = isPreview;
        finishBtn.hidden = isPreview;
        sendBtn.hidden = !isPreview;
        pauseBtn.textContent = recorderState === 'paused' ? '▶️' : '⏸️';
        pauseBtn.title = recorderState === 'paused' ? 'Resume recording' : 'Pause recording';
      }
      function resetRecorder() {
        if (recordedObjectUrl) URL.revokeObjectURL(recordedObjectUrl);
        recordedObjectUrl = null;
        recordedBlob = null;
        recordedChunks = [];
        recordingElapsedMs = 0;
        mediaRecorder = null;
        previewPlayer.removeAttribute('src');
        timeEl.textContent = '00:00';
        stopTimer();
        recorderState = 'idle';
        syncUI();
        ctx.setChrome(null);
      }

      async function startRecording() {
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return; // unsupported - silent no-op, see class doc comment
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
          return; // permission denied / no device - stays idle
        }
        mediaStream = stream;
        recordedChunks = [];
        recordingElapsedMs = 0;
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
        mediaRecorder.onstop = () => {
          for (const track of mediaStream.getTracks()) track.stop();
          mediaStream = null;
          if (discardingOnStop) {
            discardingOnStop = false;
            resetRecorder();
            return;
          }
          recordedBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
          if (recordedBlob.size === 0) { resetRecorder(); return; }
          recordedObjectUrl = URL.createObjectURL(recordedBlob);
          previewPlayer.src = recordedObjectUrl;
          stopTimer();
          recorderState = 'preview';
          syncUI();
        };
        mediaRecorder.start();
        recordingSpanStartedAt = Date.now();
        recorderState = 'recording';
        startTimer();
        syncUI();
        ctx.setChrome(panel);
      }

      function togglePause() {
        if (recorderState === 'recording') {
          recordingElapsedMs += Date.now() - recordingSpanStartedAt;
          mediaRecorder?.pause();
          stopTimer();
          recorderState = 'paused';
          syncUI();
        } else if (recorderState === 'paused') {
          recordingSpanStartedAt = Date.now();
          mediaRecorder?.resume();
          recorderState = 'recording';
          startTimer();
          syncUI();
        }
      }
      function finishRecording() {
        if (recorderState !== 'recording' && recorderState !== 'paused') return;
        mediaRecorder?.stop(); // onstop above moves recorderState to 'preview'
      }
      function discardRecording() {
        if (recorderState === 'recording' || recorderState === 'paused') {
          discardingOnStop = true;
          stopTimer();
          mediaRecorder?.stop();
          return;
        }
        if (recorderState === 'preview') resetRecorder();
      }
      async function sendRecording() {
        if (recorderState !== 'preview' || !recordedBlob) return;
        sendBtn.disabled = true;
        try {
          const assetId = globalThis.crypto.randomUUID();
          const file = new File([recordedBlob], `voice-${Date.now()}.webm`, { type: recordedBlob.type });
          const meta = await assetService.upload(spaceId, assetId, file, { readerPubs, asSpaceId });
          ctx.submitNow({ attachments: [{ assetId, ...meta }] });
          resetRecorder();
        } finally {
          sendBtn.disabled = false;
        }
      }

      discardBtn.addEventListener('click', discardRecording);
      pauseBtn.addEventListener('click', togglePause);
      finishBtn.addEventListener('click', finishRecording);
      sendBtn.addEventListener('click', sendRecording);

      ctx.registerAction({ id: 'voice-trigger', icon: trigger, label: triggerTitle, onClick: startRecording });
      ctx.registerSubmitCandidate({ id: 'voice-send', icon: trigger, label: triggerTitle, when: (s) => !s.hasText && !s.hasContribution, onClick: startRecording });

      return () => {
        if (recorderState !== 'idle') discardRecording();
        ctx.unregisterAction('voice-trigger');
        ctx.unregisterSubmitCandidate('voice-send');
      };
    },
  };
}
