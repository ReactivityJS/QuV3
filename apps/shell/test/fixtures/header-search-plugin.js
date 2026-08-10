/** Test fixture - a fake `shell.headerAction` contributor's client module. See header.test.js. */
export function renderHeaderSearch(container, { getContext, onContextChange }) {
  const link = document.createElement('a');
  link.dataset.testHeaderAction = 'true';
  function update() {
    const { appId, segments } = getContext();
    link.textContent = `search:${appId ?? 'none'}:${segments.join(',')}`;
  }
  update();
  onContextChange(update);
  container.appendChild(link);
}
