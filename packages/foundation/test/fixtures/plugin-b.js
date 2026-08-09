/** Test fixture - a SECOND fake contributor app's client module. See extension-points.test.js. */
export function renderBookmark(container, payload) {
  const btn = document.createElement('button');
  btn.textContent = `bookmark:${payload.id}`;
  container.appendChild(btn);
}

export function getMenuItems(payload) {
  return [{ id: 'bookmark', label: `Bookmark ${payload.id}` }];
}
