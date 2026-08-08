/**
 * ONBOARDING — the "this browser has no identity yet" screen, shown by
 * `client.js`'s boot INSTEAD of silently auto-generating a fresh identity,
 * before the real shell chrome/nav ever mounts. Two paths:
 *   - Create a new identity: generates a mnemonic, shows it once (the ONLY
 *     time it's ever recoverable), requires an explicit "I saved it"
 *     confirmation before importing it.
 *   - Import an existing identity: paste the same 24-word recovery phrase
 *     back in.
 *
 * Trimmed from the prototype this is rebuilt from (QuV2's
 * `apps/shell/src/onboarding.js`), which also offered a QR-code camera
 * scan for a separate "backup code" transfer format
 * (`exportSeedCode()`/`importSeedCode()`) - deliberately NOT ported this
 * round: no `@qu/qr` package exists in V3 yet, and pasting the SAME
 * recovery phrase back in for both create/import is simpler and needs no
 * second encoded format. Comes back with its own real caller, not
 * speculatively now.
 *
 * Renders directly into `document.body` (no shell chrome exists yet at
 * this point in boot) and resolves once an identity has actually been
 * stored.
 */
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme } from '@qu/ui';

const DICT = {
  en: {
    welcome: 'Welcome to Quniverse',
    intro: 'This browser has no identity yet. Create a new one, or import an existing one from its recovery phrase.',
    createNew: 'Create a new identity',
    importExisting: 'Import an existing identity',
    mnemonicIntro: 'Write this recovery phrase down and store it somewhere safe. It is the ONLY way to recover this identity - it will not be shown again.',
    copy: 'Copy',
    copied: 'Copied!',
    mnemonicConfirm: 'I have saved this recovery phrase',
    continue: 'Continue',
    back: 'Back',
    importIntro: 'Paste the 24-word recovery phrase for the identity you want to import.',
    pastePlaceholder: 'word word word ...',
    import: 'Import',
    importFailed: 'Import failed: {message}',
  },
  de: {
    welcome: 'Willkommen bei Quniverse',
    intro: 'Dieser Browser hat noch keine Identität. Erstelle eine neue, oder importiere eine bestehende aus ihrer Wiederherstellungsphrase.',
    createNew: 'Neue Identität erstellen',
    importExisting: 'Bestehende Identität importieren',
    mnemonicIntro: 'Schreibe diese Wiederherstellungsphrase auf und bewahre sie sicher auf. Sie ist der EINZIGE Weg, diese Identität wiederherzustellen - sie wird nicht erneut angezeigt.',
    copy: 'Kopieren',
    copied: 'Kopiert!',
    mnemonicConfirm: 'Ich habe diese Wiederherstellungsphrase gespeichert',
    continue: 'Weiter',
    back: 'Zurück',
    importIntro: 'Füge die 24-Wort-Wiederherstellungsphrase der zu importierenden Identität ein.',
    pastePlaceholder: 'wort wort wort ...',
    import: 'Importieren',
    importFailed: 'Import fehlgeschlagen: {message}',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-onboarding-style';
const STYLE = `
  .qu-onboard { max-width: 32rem; margin: 3rem auto; padding: 0 1.2rem; display: flex; flex-direction: column; gap: 1rem; }
  .qu-onboard h1 { margin: 0; }
  .qu-onboard p { opacity: 0.85; line-height: 1.5; }
  .qu-onboard-choices { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.5rem; }
  .qu-onboard-choices button { padding: 0.8rem 1rem; font-size: 1rem; border-radius: var(--qu-radius-md, 0.5rem); border: 1px solid var(--qu-color-border, #8884); background: transparent; color: inherit; cursor: pointer; text-align: left; }
  .qu-onboard-mnemonic { font-family: var(--qu-font-mono, ui-monospace, monospace); font-size: 1.05em; line-height: 1.8; background: var(--qu-color-surface, #8881); border-radius: var(--qu-radius-md, 0.5rem); padding: 0.8rem 1rem; word-spacing: 0.3em; }
  .qu-onboard-warning { border-left: 3px solid #d0a02a; padding-left: 0.7rem; }
  .qu-onboard-row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  .qu-onboard textarea { width: 100%; min-height: 4rem; font-family: var(--qu-font-mono, ui-monospace, monospace); padding: 0.5rem; box-sizing: border-box; }
  .qu-onboard-error { color: #c0392b; }
  .qu-onboard label { display: flex; align-items: center; gap: 0.5rem; }
  .qu-onboard button[disabled] { opacity: 0.5; cursor: not-allowed; }
`;

/**
 * @param {HTMLElement} root - Cleared and populated (typically `document.body`).
 * @param {import('@qu/identity').QuIdentityEngine} identity
 * @returns {Promise<'created'|'imported'>}
 */
export function renderOnboarding(root, identity) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  return new Promise((resolve) => {
    renderChoice();

    function wrap() {
      root.textContent = '';
      const el = document.createElement('div');
      el.className = 'qu-onboard';
      root.appendChild(el);
      return el;
    }

    function renderChoice() {
      const el = wrap();
      const h1 = document.createElement('h1');
      h1.textContent = t('welcome');
      const intro = document.createElement('p');
      intro.textContent = t('intro');
      const choices = document.createElement('div');
      choices.className = 'qu-onboard-choices';

      const createBtn = document.createElement('button');
      createBtn.type = 'button';
      createBtn.textContent = t('createNew');
      createBtn.addEventListener('click', renderCreate);

      const importBtn = document.createElement('button');
      importBtn.type = 'button';
      importBtn.textContent = t('importExisting');
      importBtn.addEventListener('click', renderImport);

      choices.append(createBtn, importBtn);
      el.append(h1, intro, choices);
    }

    function renderCreate() {
      const el = wrap();
      const mnemonic = identity.generateMnemonic();

      const h1 = document.createElement('h1');
      h1.textContent = t('createNew');
      const warning = document.createElement('p');
      warning.className = 'qu-onboard-warning';
      warning.textContent = t('mnemonicIntro');

      const box = document.createElement('div');
      box.className = 'qu-onboard-mnemonic';
      box.textContent = mnemonic;

      const copyRow = document.createElement('div');
      copyRow.className = 'qu-onboard-row';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = t('copy');
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(mnemonic);
          copyBtn.textContent = t('copied');
          setTimeout(() => { copyBtn.textContent = t('copy'); }, 1500);
        } catch { /* clipboard unavailable - the visible box above is still copyable by hand */ }
      });
      copyRow.appendChild(copyBtn);

      const confirmLabel = document.createElement('label');
      const confirmCheckbox = document.createElement('input');
      confirmCheckbox.type = 'checkbox';
      const continueBtn = document.createElement('button');
      continueBtn.type = 'button';
      continueBtn.textContent = t('continue');
      continueBtn.disabled = true;
      confirmCheckbox.addEventListener('change', () => { continueBtn.disabled = !confirmCheckbox.checked; });
      confirmLabel.append(confirmCheckbox, document.createTextNode(t('mnemonicConfirm')));

      const backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.textContent = t('back');
      backBtn.addEventListener('click', renderChoice);

      continueBtn.addEventListener('click', async () => {
        continueBtn.disabled = true;
        await identity.importMnemonic(mnemonic);
        resolve('created');
      });

      const actions = document.createElement('div');
      actions.className = 'qu-onboard-row';
      actions.append(backBtn, continueBtn);

      el.append(h1, warning, box, copyRow, confirmLabel, actions);
    }

    function renderImport() {
      const el = wrap();
      const h1 = document.createElement('h1');
      h1.textContent = t('importExisting');
      const intro = document.createElement('p');
      intro.textContent = t('importIntro');

      const textarea = document.createElement('textarea');
      textarea.placeholder = t('pastePlaceholder');

      const importBtn = document.createElement('button');
      importBtn.type = 'button';
      importBtn.textContent = t('import');

      const backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.textContent = t('back');
      backBtn.addEventListener('click', renderChoice);

      const error = document.createElement('p');
      error.className = 'qu-onboard-error';

      importBtn.addEventListener('click', async () => {
        error.textContent = '';
        try {
          await identity.importMnemonic(textarea.value.trim());
          resolve('imported');
        } catch (err) {
          error.textContent = t('importFailed', { message: err.message });
        }
      });

      const actions = document.createElement('div');
      actions.className = 'qu-onboard-row';
      actions.append(backBtn, importBtn);

      el.append(h1, intro, textarea, actions, error);
    }
  });
}
