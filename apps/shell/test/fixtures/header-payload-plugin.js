/** Test fixture - a `shell.headerAction` contributor that records which payload keys it received. See header.test.js. */
export function renderHeaderPayloadProbe(container, payload) {
  const el = document.createElement('span');
  el.dataset.testPayloadProbe = 'true';
  el.textContent = Object.keys(payload).sort().join(',');
  container.appendChild(el);
}
