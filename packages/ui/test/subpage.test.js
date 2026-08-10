import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';

installDom();
const { renderSubpage } = await import('../src/subpage.js');

test('builds a back link and an empty content area, then calls render(content)', () => {
  const container = document.createElement('div');
  let renderedContent = null;
  renderSubpage(container, {
    backHref: '#/notes',
    backLabel: '← Back to Notes',
    render: (content) => { renderedContent = content; content.textContent = 'hello'; },
  });

  const back = container.querySelector('a.qu-subpage-back');
  assert.ok(back);
  assert.equal(back.getAttribute('href'), '#/notes');
  assert.equal(back.textContent, '← Back to Notes');

  const content = container.querySelector('.qu-subpage-content');
  assert.equal(content, renderedContent);
  assert.equal(content.textContent, 'hello');
});

test('showBackLink: false skips the back link entirely, content still renders', () => {
  const container = document.createElement('div');
  let renderedContent = null;
  renderSubpage(container, {
    showBackLink: false,
    render: (content) => { renderedContent = content; content.textContent = 'hello'; },
  });

  assert.equal(container.querySelector('a.qu-subpage-back'), null);
  const content = container.querySelector('.qu-subpage-content');
  assert.equal(content, renderedContent);
  assert.equal(content.textContent, 'hello');
});

test('clears any previous content on a re-render', () => {
  const container = document.createElement('div');
  container.textContent = 'stale content from a previous mount';
  renderSubpage(container, { backHref: '#/x', backLabel: 'Back', render: () => {} });
  assert.equal(container.textContent.includes('stale content'), false);
});
