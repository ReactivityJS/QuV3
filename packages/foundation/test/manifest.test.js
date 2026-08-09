import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, REQUIRED_FIELDS, MANIFEST_KINDS, PUSH_ACTION_TYPES, CONTRIBUTION_KINDS } from '../src/manifest.js';

function minimal(overrides = {}) {
  return { name: 'thing', version: '1.0.0', main: './index.js', ...overrides };
}

test('accepts a minimal valid manifest and returns it unchanged', () => {
  const manifest = minimal();
  assert.equal(validateManifest(manifest), manifest);
});

test('rejects a non-object manifest', () => {
  assert.throws(() => validateManifest(null), /expected a JSON object/);
  assert.throws(() => validateManifest('a string'), /expected a JSON object/);
  assert.throws(() => validateManifest(undefined), /expected a JSON object/);
});

test('rejects a manifest missing any required field', () => {
  for (const field of REQUIRED_FIELDS) {
    const manifest = minimal();
    delete manifest[field];
    assert.throws(() => validateManifest(manifest), new RegExp(`required field "${field}"`));
  }
});

test('rejects a non-string required field', () => {
  assert.throws(() => validateManifest(minimal({ name: 123 })), /required field "name"/);
});

test('accepts every valid `kind`, rejects an invalid one', () => {
  for (const kind of MANIFEST_KINDS) {
    assert.doesNotThrow(() => validateManifest(minimal({ kind })));
  }
  assert.throws(() => validateManifest(minimal({ kind: 'not-a-kind' })), /"kind" must be one of/);
});

test('`requires`/`provides` must be arrays of strings', () => {
  assert.doesNotThrow(() => validateManifest(minimal({ requires: ['a', 'b'] })));
  assert.throws(() => validateManifest(minimal({ requires: 'not-an-array' })), /"requires" must be an array of strings/);
  assert.throws(() => validateManifest(minimal({ provides: [1, 2] })), /"provides" must be an array of strings/);
});

test('`integrity`/`clientIntegrity` must look like "sha256-<base64>"', () => {
  assert.doesNotThrow(() => validateManifest(minimal({ integrity: 'sha256-AbC123+/=' })));
  assert.throws(() => validateManifest(minimal({ integrity: 'not-sha256' })), /"integrity" must look like/);
  assert.doesNotThrow(() => validateManifest(minimal({ clientIntegrity: 'sha256-AbC123+/=' })));
  assert.throws(() => validateManifest(minimal({ clientIntegrity: 'md5-nope' })), /"clientIntegrity" must look like/);
});

test('string-typed nav/UI fields reject non-string values', () => {
  for (const field of ['label', 'icon', 'clientMain', 'signature', 'clientSignature']) {
    assert.throws(() => validateManifest(minimal({ [field]: 42 })), new RegExp(`"${field}" must be a string`));
  }
});

test('`navOrder` must be a number', () => {
  assert.doesNotThrow(() => validateManifest(minimal({ navOrder: 5 })));
  assert.throws(() => validateManifest(minimal({ navOrder: '5' })), /"navOrder" must be a number/);
});

test('`pushActions` validates shape and the optional `type` enum', () => {
  assert.doesNotThrow(() => validateManifest(minimal({ pushActions: [{ id: 'mention', label: 'Mentions' }] })));
  for (const type of PUSH_ACTION_TYPES) {
    assert.doesNotThrow(() => validateManifest(minimal({ pushActions: [{ id: 'x', label: 'X', type }] })));
  }
  assert.throws(
    () => validateManifest(minimal({ pushActions: [{ id: 'x', label: 'X', type: 'not-a-type' }] })),
    /"pushActions" must be an array/
  );
  assert.throws(() => validateManifest(minimal({ pushActions: [{ id: 'x' }] })), /"pushActions" must be an array/); // missing label
  assert.throws(() => validateManifest(minimal({ pushActions: 'nope' })), /"pushActions" must be an array/);
});

test('`actions` validates the {slot, id, label, hrefTemplate, icon?, order?} shape', () => {
  assert.doesNotThrow(() =>
    validateManifest(minimal({ actions: [{ slot: 'contact-row', id: 'chat', label: 'Chat', hrefTemplate: '#/chat/{pub}' }] }))
  );
  assert.doesNotThrow(() =>
    validateManifest(minimal({ actions: [{ slot: 'x', id: 'y', label: 'Y', hrefTemplate: '#/y', icon: '🎯', order: 5 }] }))
  );
  // Old field name "mount" is intentionally NOT accepted - the schema uses "slot" (see actions.js).
  assert.throws(
    () => validateManifest(minimal({ actions: [{ mount: 'contact-row', id: 'chat', label: 'Chat', hrefTemplate: '#/x' }] })),
    /"actions" must be an array of \{slot, id, label, hrefTemplate/
  );
  assert.throws(
    () => validateManifest(minimal({ actions: [{ slot: 'x', id: 'y', label: 'Y' }] })), // missing hrefTemplate
    /"actions" must be an array/
  );
});

test('`spaceId` must be a UUID', () => {
  assert.doesNotThrow(() => validateManifest(minimal({ spaceId: '4eb04aa2-4ca9-4c9a-aa7e-33ad3802edb1' })));
  assert.throws(() => validateManifest(minimal({ spaceId: 'forum' })), /"spaceId" must be a UUID/);
  assert.throws(() => validateManifest(minimal({ spaceId: 'not-a-uuid-at-all' })), /"spaceId" must be a UUID/);
});

test('`contributes` validates the {point, export, kind?, order?} shape', () => {
  assert.doesNotThrow(() =>
    validateManifest(minimal({ contributes: [{ point: 'content.messageActions', export: 'renderLikeButton' }] }))
  );
  for (const kind of CONTRIBUTION_KINDS) {
    assert.doesNotThrow(() => validateManifest(minimal({ contributes: [{ point: 'x', export: 'y', kind, order: 5 }] })));
  }
  assert.throws(
    () => validateManifest(minimal({ contributes: [{ point: 'x', export: 'y', kind: 'not-a-kind' }] })),
    /"contributes" must be an array/
  );
  assert.throws(
    () => validateManifest(minimal({ contributes: [{ point: 'x' }] })), // missing export
    /"contributes" must be an array/
  );
  assert.throws(() => validateManifest(minimal({ contributes: 'nope' })), /"contributes" must be an array/);
});

test('`definesExtensionPoints` validates the {point, kind?, description?} shape', () => {
  assert.doesNotThrow(() => validateManifest(minimal({ definesExtensionPoints: [{ point: 'content.messageActions' }] })));
  for (const kind of CONTRIBUTION_KINDS) {
    assert.doesNotThrow(() =>
      validateManifest(minimal({ definesExtensionPoints: [{ point: 'x', kind, description: 'what it means' }] }))
    );
  }
  assert.throws(
    () => validateManifest(minimal({ definesExtensionPoints: [{ point: 'x', kind: 'not-a-kind' }] })),
    /"definesExtensionPoints" must be an array/
  );
  assert.throws(
    () => validateManifest(minimal({ definesExtensionPoints: [{ description: 'missing point' }] })),
    /"definesExtensionPoints" must be an array/
  );
  assert.throws(() => validateManifest(minimal({ definesExtensionPoints: 'nope' })), /"definesExtensionPoints" must be an array/);
});

test('omitting every optional field is valid', () => {
  assert.doesNotThrow(() => validateManifest(minimal()));
});
