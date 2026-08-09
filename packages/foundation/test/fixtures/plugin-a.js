/** Test fixture - a fake contributor app's client module. See extension-points.test.js. */
export function renderLike(container, payload) {
  const btn = document.createElement('button');
  btn.textContent = `like:${payload.id}`;
  container.appendChild(btn);
}

export function getMenuItems(payload) {
  return [{ id: 'like', label: `Like ${payload.id}` }];
}

export function throwingRender() {
  throw new Error('plugin-a: render boom');
}

export function throwingCollect() {
  throw new Error('plugin-a: collect boom');
}
