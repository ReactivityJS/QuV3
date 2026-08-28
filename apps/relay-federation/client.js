/**
 * RELAY FEDERATION (client-facing) — the two client-triggered entry points
 * for "a client learns about a foreign relay and suggests it to its own
 * relay's admin", both talking to the relay's existing, signed
 * `POST /federation/suggest` endpoint (see
 * `packages/relay/src/http-router.js`'s `#handleFederationSuggest`,
 * `packages/relay/src/federation-manager.js`'s `suggestPeer()`):
 *
 *   1. `renderSettingsContribution()` - a `userSettings.contributions`
 *      contribution (see `apps/profile/manifest.quapp`'s own doc comment on
 *      that point), rendered at the bottom of `#/~<pub>/settings`. Offers a
 *      plain "suggest this URL" text field, AND a "generate a share link"
 *      utility that turns any relay URL into a `#/relay-federation/invite/
 *      <url>` link.
 *   2. `mount()` - this app's OWN route, `#/relay-federation/invite/
 *      <encodeURIComponent(url)>` - what opening a link generated above (or
 *      shared by someone else) lands on: a confirmation screen offering to
 *      suggest that URL to THIS relay (the one currently being viewed on),
 *      not the relay that generated the link.
 *
 * BOTH READ THE SAME TWO RELAY SETTINGS FLAGS (`settings.federation.
 * allowClientSuggestViaSettings`/`allowClientSuggestViaShare` - see
 * `packages/relay/src/relay-settings.js`'s own doc comment) before showing
 * anything - both default OFF. This is a UX courtesy only, same "client
 * hint, server gate" split every other admin-configurable surface in this
 * codebase already has (e.g. `apps/relay-admin/client.js`'s own top doc
 * comment): the relay's `#handleFederationSuggest()` independently re-checks
 * the SAME flags server-side and refuses the POST outright if both are off,
 * so a modified client can't suggest anything an admin hasn't opted into
 * either way.
 *
 * There is no shared `/config.json` cache in this codebase (every app reads
 * it itself - see `apps/relay-admin/client.js`'s own identical pattern), so
 * both entry points below fetch it independently at their own mount/render
 * time.
 */
import { QuCrypto } from '@qu/core';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme } from '@qu/ui';

const DICT = {
  en: {
    title: 'Relay federation',
    suggestLabel: 'Suggest a relay to this relay\'s admin',
    suggestPlaceholder: 'wss://relay.example.com',
    suggestButton: 'Suggest',
    shareLabel: 'Create a shareable invite link for a relay',
    sharePlaceholder: 'wss://relay.example.com',
    shareButton: 'Generate link',
    suggestResultAdded: 'Added - this relay is now federating with it.',
    suggestResultPending: 'Suggested - awaiting admin approval.',
    suggestResultAlreadyKnown: 'This relay already knows about that URL.',
    suggestFailed: 'Could not suggest this relay: {error}',
    noInvite: 'No relay invite link was given.',
    shareDisabled: 'This relay does not accept relay suggestions via invite link.',
    inviteIntro: 'You opened an invite link for a foreign relay:',
    inviteConfirm: 'Suggest this relay to this relay\'s admin',
    probeOk: 'Looks like a genuine Qu relay (~{relayId}…).',
  },
  de: {
    title: 'Relay-Föderation',
    suggestLabel: 'Ein Relay dem Admin dieses Relays vorschlagen',
    suggestPlaceholder: 'wss://relay.example.com',
    suggestButton: 'Vorschlagen',
    shareLabel: 'Einen teilbaren Einladungslink für ein Relay erzeugen',
    sharePlaceholder: 'wss://relay.example.com',
    shareButton: 'Link erzeugen',
    suggestResultAdded: 'Hinzugefügt - dieses Relay föderiert nun damit.',
    suggestResultPending: 'Vorgeschlagen - wartet auf Bestätigung durch den Admin.',
    suggestResultAlreadyKnown: 'Dieses Relay kennt diese URL bereits.',
    suggestFailed: 'Relay konnte nicht vorgeschlagen werden: {error}',
    noInvite: 'Kein Relay-Einladungslink angegeben.',
    shareDisabled: 'Dieses Relay akzeptiert keine Relay-Vorschläge über Einladungslinks.',
    inviteIntro: 'Du hast einen Einladungslink für ein fremdes Relay geöffnet:',
    inviteConfirm: 'Dieses Relay dem Admin dieses Relays vorschlagen',
    probeOk: 'Sieht nach einem echten Qu-Relay aus (~{relayId}…).',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-relay-federation-style';
const STYLE = `
  .qu-relay-federation-block { margin: 0.6rem 0; display: flex; flex-direction: column; gap: 0.3rem; max-width: 26rem; }
  .qu-relay-federation-block label { font-size: 0.9em; opacity: 0.85; }
  .qu-relay-federation-block input[type="text"] { font: inherit; padding: 0.3rem 0.5rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-relay-federation-status { font-size: 0.9em; margin: 0.2rem 0; }
  .qu-relay-federation-status-error { color: var(--qu-color-danger, #d64545); }
  .qu-relay-federation-hint { font-size: 0.85em; opacity: 0.75; }
`;

/**
 * Signs `{url}` with this identity's main key and POSTs it to
 * `/federation/suggest` - shared by both entry points below. See
 * `apps/relay-admin/client.js`'s own "Retry" action for the identical
 * sign-a-small-payload pattern this mirrors.
 * @param {string} url
 * @param {import('@qu/identity').QuIdentityEngine} identity
 * @param {string} myPub
 * @returns {Promise<{status: 'added'|'pending'|'already-known'}>}
 * @throws {Error} On any non-2xx response, with the server's own error message.
 */
async function suggestRelay(url, identity, myPub) {
  const mainKey = await identity.getMainKey();
  const signature = await QuCrypto.sign(new TextEncoder().encode(JSON.stringify({ url })), mainKey.privateKeyPkcs8);
  const res = await fetch('/federation/suggest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actorPub: myPub, url, signature: QuCrypto.toBase64Url(signature) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** @returns {Promise<object|null>} `/config.json`'s parsed body, or null if unreachable - same best-effort convention as apps/relay-admin/client.js's own fetch. */
async function fetchConfig() {
  try {
    const res = await fetch('/config.json');
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort, INFORMATIONAL-ONLY probe of a candidate relay URL - never
 * blocks or gates suggesting it. The relay's own `probeRelayInfo()`
 * (`packages/relay/src/federation-manager.js`) does the real, authoritative
 * check server-side once a suggestion is actually submitted; this is purely
 * a "does this look right before you commit" hint, so any failure here
 * (network, CORS, malformed response) just means no hint is shown, exactly
 * like `packages/relay/src/link-preview.js`'s own "never throws" convention.
 * @param {string} url
 * @returns {Promise<{relayId: string}|null>}
 */
async function probeRelayInfo(url) {
  try {
    const infoUrl = new URL('/relay-info', url).toString();
    const res = await fetch(infoUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.relayId === 'string' ? body : null;
  } catch {
    return null;
  }
}

/** @param {HTMLElement} parent @param {string} messageKey @param {object} [params] @returns {HTMLElement} */
function appendStatus(parent, messageKey, params, isError) {
  const status = document.createElement('p');
  status.className = isError ? 'qu-relay-federation-status qu-relay-federation-status-error' : 'qu-relay-federation-status';
  status.textContent = t(messageKey, params);
  parent.appendChild(status);
  return status;
}

/** @param {{status: string}} result @returns {string} DICT key for the result - e.g. 'suggestResultAdded'. */
function resultMessageKey(result) {
  const suffix = result.status.replace(/(^|-)([a-z])/g, (_, sep, c) => c.toUpperCase());
  return `suggestResult${suffix}`;
}

function buildSuggestForm(identity, myPub) {
  const wrap = document.createElement('div');
  wrap.className = 'qu-relay-federation-block';
  const label = document.createElement('label');
  label.textContent = t('suggestLabel');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = t('suggestPlaceholder');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = t('suggestButton');
  wrap.append(label, input, btn);

  btn.addEventListener('click', async () => {
    const url = input.value.trim();
    if (!url) return;
    btn.disabled = true;
    wrap.querySelector('.qu-relay-federation-status')?.remove();
    try {
      const result = await suggestRelay(url, identity, myPub);
      appendStatus(wrap, resultMessageKey(result));
      input.value = '';
    } catch (err) {
      appendStatus(wrap, 'suggestFailed', { error: err.message }, true);
    } finally {
      btn.disabled = false;
    }
  });
  return wrap;
}

function buildShareLinkForm() {
  const wrap = document.createElement('div');
  wrap.className = 'qu-relay-federation-block';
  const label = document.createElement('label');
  label.textContent = t('shareLabel');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = t('sharePlaceholder');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = t('shareButton');
  const linkOutput = document.createElement('input');
  linkOutput.type = 'text';
  linkOutput.readOnly = true;
  linkOutput.hidden = true;
  wrap.append(label, input, btn, linkOutput);

  btn.addEventListener('click', () => {
    const url = input.value.trim();
    if (!url) return;
    const link = `${window.location.origin}/#/relay-federation/invite/${encodeURIComponent(url)}`;
    linkOutput.value = link;
    linkOutput.hidden = false;
    linkOutput.select();
    // Best-effort - clipboard access can be denied (permissions, insecure
    // context, ...); the visible, selected, readonly field is the fallback
    // a user can always copy from by hand either way.
    navigator.clipboard?.writeText(link).catch(() => {});
  });
  return wrap;
}

/**
 * `userSettings.contributions` contributor (see this file's own top doc
 * comment) - rendered at the bottom of `#/~<pub>/settings`, into the SAME
 * container every other contributor of this point shares (see
 * `apps/profile/client.js`'s own `renderSlot()` call site).
 * @param {HTMLElement} container
 * @param {{myPub: string, services: object, identity: import('@qu/identity').QuIdentityEngine}} payload
 */
export async function renderSettingsContribution(container, { myPub, identity }) {
  const config = await fetchConfig();
  const federation = config?.settings?.federation;
  if (!federation || (!federation.allowClientSuggestViaSettings && !federation.allowClientSuggestViaShare)) {
    return; // both off (the default) - nothing to show, see relay-settings.js's own doc comment
  }
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);

  const section = document.createElement('section');
  const title = document.createElement('h2');
  title.textContent = t('title');
  section.appendChild(title);
  if (federation.allowClientSuggestViaSettings) section.appendChild(buildSuggestForm(identity, myPub));
  if (federation.allowClientSuggestViaShare) section.appendChild(buildShareLinkForm());
  container.appendChild(section);
}

/**
 * This app's OWN route: `#/relay-federation/invite/<encodeURIComponent(url)>`.
 * @param {HTMLElement} container
 * @param {{segments?: string[], identity: import('@qu/identity').QuIdentityEngine, services: object}} ctx
 */
export async function mount(container, { segments = [], identity, services }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;
  const stop = () => { stopped = true; };

  const heading = document.createElement('h1');
  heading.textContent = t('title');
  container.appendChild(heading);

  // segments[0] is this app's own name (see apps/shell/src/router.js's own
  // doc comment - the shell hands every app its FULL parsed segments array,
  // unsliced), segments[1] must be the fixed 'invite' marker, segments[2]
  // the encoded foreign relay URL.
  const encodedUrl = segments[1] === 'invite' ? segments[2] : null;
  let url = null;
  try {
    url = encodedUrl ? decodeURIComponent(encodedUrl) : null;
  } catch {
    url = null; // malformed percent-encoding - treated exactly like "no url given"
  }
  if (!url) {
    const p = document.createElement('p');
    p.textContent = t('noInvite');
    container.appendChild(p);
    return stop;
  }

  const config = await fetchConfig();
  if (stopped) return stop;
  const federation = config?.settings?.federation;
  if (!federation?.allowClientSuggestViaShare) {
    const p = document.createElement('p');
    p.textContent = t('shareDisabled');
    container.appendChild(p);
    return stop;
  }

  const myPub = await services.actors.whoAmI();
  if (stopped) return stop;

  const intro = document.createElement('p');
  intro.textContent = t('inviteIntro');
  const urlDisplay = document.createElement('code');
  urlDisplay.textContent = url;
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.textContent = t('inviteConfirm');
  container.append(intro, urlDisplay, document.createElement('br'), confirmBtn);

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    container.querySelectorAll('.qu-relay-federation-status').forEach((el) => el.remove());
    try {
      const result = await suggestRelay(url, identity, myPub);
      appendStatus(container, resultMessageKey(result));
      confirmBtn.hidden = true;
    } catch (err) {
      appendStatus(container, 'suggestFailed', { error: err.message }, true);
      confirmBtn.disabled = false;
    }
  });

  probeRelayInfo(url).then((info) => {
    if (stopped || !info) return;
    const probeNote = document.createElement('p');
    probeNote.className = 'qu-relay-federation-hint';
    probeNote.textContent = t('probeOk', { relayId: info.relayId.slice(0, 10) });
    container.insertBefore(probeNote, confirmBtn);
  }).catch(() => {});

  return stop;
}
