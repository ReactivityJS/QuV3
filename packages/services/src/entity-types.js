/**
 * ENTITY TYPE REGISTRY — Quniverse V4's Drupal-inspired "Content Type +
 * Fields" concept (see docs/v4-concept.md §3.3), kept deliberately shallow:
 * a static, code-defined composition record, NOT a persisted, admin-editable
 * schema store. That's a real, later decision (a CMS app deciding it wants
 * "define a new Content Type through the UI"), explicitly out of scope here
 * (docs/v4-concept.md §10) - building it now would be speculative generality
 * ahead of a real caller, the same discipline `paths.js`'s own doc comment
 * states for path helpers.
 *
 * BUILT TO BE SWAPPED LATER WITHOUT TOUCHING CALL SITES: the only public
 * surface is `register()`/`get()`/`list()`. Every current caller goes
 * through these three methods, never touches `#types` directly - so the day
 * a persisted schema store is built, only THIS class's internals change (the
 * `Map` becomes reads/writes through `qu`), and every existing
 * `entityTypeRegistry.get('article')` call keeps working unchanged. This is
 * the concrete mechanism behind the "static now, but designed so migrating
 * to persisted/admin-editable storage later is easy" requirement - not just
 * a promise in a comment, an actual narrow surface with nothing behind it to
 * leak.
 *
 * `get()` returns `null` for an unknown type rather than throwing -
 * `EntityService` (entity-service.js) treats an unregistered `type` as
 * "allowed, but nothing extra to validate/normalize against," matching this
 * codebase's general open-by-default posture (see access-engine.js) rather
 * than making this registry the first hard schema gate in the Entity layer.
 *
 * @typedef {Object} EntityTypeDefinition
 * @property {Record<string, string>} [fields] - Field name -> a caller-defined
 *   type label (e.g. `'text'`, `'datetime'`, `'attachment'`, `'ref:actor'`).
 *   Purely descriptive in V4 Phase 1 - nothing here validates field values
 *   yet (see docs/v4-concept.md §3.3's own "deliberately shallow" framing).
 * @property {boolean} [content=false] - Whether entities of this type carry
 *   a `content` field (see content.js's `createContent()`).
 * @property {string[]} [capabilities] - Which optional Capabilities
 *   (`'commentable'`, `'reactable'`, `'followable'`, `'bookmarkable'`,
 *   `'mentionable'`, `'taggable'`, `'attachable'`, `'notifiable'`) this type
 *   supports - see docs/v4-concept.md §4. Advisory only in Phase 1: nothing
 *   here enforces that e.g. only a `'commentable'` type gets comments.
 */
export class EntityTypeRegistry {
  #types = new Map();

  /**
   * @param {string} type
   * @param {EntityTypeDefinition} definition
   */
  register(type, definition) {
    this.#types.set(type, { fields: {}, content: false, capabilities: [], ...definition });
  }

  /** @param {string} type @returns {EntityTypeDefinition|null} `null` if `type` was never registered. */
  get(type) {
    return this.#types.get(type) ?? null;
  }

  /** @returns {Array<{type: string, definition: EntityTypeDefinition}>} Every registered type, in registration order. */
  list() {
    return [...this.#types.entries()].map(([type, definition]) => ({ type, definition }));
  }
}

/**
 * The seven EntityTypes specified in docs/v4-concept.md §3.3, seeded onto a
 * shared default instance - most callers just want `defaultEntityTypes`, not
 * their own empty registry.
 */
export const defaultEntityTypes = new EntityTypeRegistry();

defaultEntityTypes.register('topic', {
  fields: { title: 'text' },
  content: true,
  capabilities: ['commentable', 'reactable', 'followable', 'attachable'],
});

defaultEntityTypes.register('message', {
  fields: {},
  content: true,
  capabilities: ['reactable', 'attachable', 'mentionable'],
});

defaultEntityTypes.register('article', {
  fields: { title: 'text', coverImage: 'attachment' },
  content: true,
  capabilities: ['commentable', 'bookmarkable', 'taggable'],
});

defaultEntityTypes.register('page', {
  fields: { title: 'text', route: 'text' },
  content: true,
  capabilities: ['attachable'],
});

defaultEntityTypes.register('notification', {
  fields: {},
  content: true,
  capabilities: ['notifiable'],
});

defaultEntityTypes.register('task', {
  fields: { status: 'enum', dueDate: 'datetime', assignee: 'ref:actor' },
  content: true,
  capabilities: ['commentable', 'attachable'],
});

defaultEntityTypes.register('event', {
  fields: { title: 'text', start: 'datetime', end: 'datetime', location: 'text' },
  content: true,
  capabilities: ['reactable'],
});
