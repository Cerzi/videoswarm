import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { requireSqliteSuite } from './sqliteTestGate';

const require = createRequire(import.meta.url);

let database;
let databaseLoadError;
try {
  const BetterSqlite = require('better-sqlite3');
  const probe = new BetterSqlite(':memory:');
  probe.close();
  database = require('../database');
} catch (error) {
  databaseLoadError = error;
}

const sqliteDescribe = requireSqliteSuite(
  describe,
  !database || databaseLoadError
    ? databaseLoadError || new Error('better-sqlite3 probe failed')
    : null
);

// Tag suggestions' storage (prompt-search-and-tag-suggestions.md, Section 2):
// what learning reads, per-clip targets, turned-down suggestions and the
// library search for clips that might be a tag.
if (!database || databaseLoadError) {
  sqliteDescribe('tag suggestion storage', () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;
  const pk = (letter) => `pk2-${letter.repeat(32)}`;
  const gk = (letter) => `gk3-${letter.repeat(32)}`;

  sqliteDescribe('tag suggestion storage', () => {
    let tempDir;
    let store;
    let rootPath;
    let seen;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-tagsuggest-'));
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();
      rootPath = path.join(tempDir, 'clips');
      seen = [];
    });

    afterEach(() => {
      resetDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    async function clip(name, promptLetter = null) {
      const filePath = path.join(rootPath, name);
      fs.mkdirSync(rootPath, { recursive: true });
      fs.writeFileSync(filePath, `content of ${name}`);
      const [indexed] = await store.indexFiles({
        rootPath,
        entries: [{ filePath, stats: fs.statSync(filePath) }],
      });
      seen.push(filePath);
      store.reconcileLibraryRoot(rootPath, seen, { recursive: true, completeCoverage: true });
      if (promptLetter) {
        store.setGenerationKeys([
          {
            fingerprint: indexed.fingerprint,
            generationKey: gk(promptLetter),
            promptKey: pk(promptLetter),
          },
        ]);
      }
      return { filePath, fingerprint: indexed.fingerprint, instanceId: indexed.instance.id };
    }

    it('gives learning the tags and turned-down suggestions of present clips with prompts', async () => {
      const dancing = await clip('dancing.mp4', 'a');
      const harbour = await clip('harbour.mp4', 'b');
      const noPrompt = await clip('plain.mp4');
      store.assignTags([dancing.fingerprint, noPrompt.fingerprint], ['dance']);
      store.assignTags([harbour.fingerprint], ['sea']);
      expect(store.dismissTagSuggestion([harbour.fingerprint], 'dance')).toBe(1);

      const labels = store.getTagSuggestionLabels();
      const idOf = (name) => labels.tags.find((tag) => tag.name === name).id;
      expect(labels.links).toEqual(
        expect.arrayContaining([
          { promptKey: pk('a'), fingerprint: dancing.fingerprint, tagId: idOf('dance') },
          { promptKey: pk('b'), fingerprint: harbour.fingerprint, tagId: idOf('sea') },
        ])
      );
      // A clip without a prompt key teaches nothing.
      expect(labels.links).toHaveLength(2);
      expect(labels.dismissals).toEqual([
        { promptKey: pk('b'), fingerprint: harbour.fingerprint, tagId: idOf('dance') },
      ]);

      // A clip gone from the library teaches nothing either.
      seen = seen.filter((filePath) => filePath !== dancing.filePath);
      store.reconcileLibraryRoot(rootPath, seen, { recursive: true, completeCoverage: true });
      expect(store.getTagSuggestionLabels().links.map((row) => row.promptKey)).toEqual([pk('b')]);
    });

    it('describes clips as targets with their prompt key, tags and turned-down tags', async () => {
      const dancing = await clip('dancing.mp4', 'a');
      const plain = await clip('plain.mp4');
      store.assignTags([dancing.fingerprint], ['dance', 'stage']);
      store.assignTags([plain.fingerprint], ['sea']);
      store.dismissTagSuggestion([dancing.fingerprint], 'sea');
      const ids = Object.fromEntries(store.listTags().map((tag) => [tag.name, tag]));
      const labels = store.getTagSuggestionLabels();
      const idOf = (name) => labels.tags.find((tag) => tag.name === name).id;
      expect(ids.sea).toBeTruthy();

      const targets = store.getTagSuggestionTargets([dancing.instanceId, plain.instanceId, 999_999]);
      const byId = new Map(targets.map((target) => [target.instanceId, target]));
      expect(byId.size).toBe(2);
      expect(byId.get(dancing.instanceId)).toEqual({
        instanceId: dancing.instanceId,
        fingerprint: dancing.fingerprint,
        promptKey: pk('a'),
        tagIds: [idOf('dance'), idOf('stage')].sort((a, b) => a - b),
        dismissedTagIds: [idOf('sea')],
      });
      expect(byId.get(plain.instanceId)).toMatchObject({ promptKey: null, dismissedTagIds: [] });
      expect(() => store.getTagSuggestionTargets(Array.from({ length: 50_001 }, (_, i) => i + 1))).toThrow(
        /At most 50000/
      );
    });

    it('turns a suggestion down once, only for tags that exist, and forgets it with the tag', async () => {
      const dancing = await clip('dancing.mp4', 'a');
      const other = await clip('other.mp4', 'b');
      store.assignTags([other.fingerprint], ['sea']);
      expect(store.dismissTagSuggestion([dancing.fingerprint], 'no-such-tag')).toBe(0);
      expect(store.dismissTagSuggestion([dancing.fingerprint, 'unknown-content'], 'SEA')).toBe(1);
      expect(store.dismissTagSuggestion([dancing.fingerprint], 'sea')).toBe(0);
      expect(store.getTagSuggestionLabels().dismissals).toHaveLength(1);

      // The last clip leaving the tag removes it, and what was turned down
      // about it goes too.
      store.removeTag([other.fingerprint], 'sea');
      expect(store.getTagSuggestionLabels().dismissals).toEqual([]);
    });

    it('searches the library for clips that might be a tag, minus tagged and turned-down ones', async () => {
      await clip('open.mp4', 'a');
      const tagged = await clip('tagged.mp4', 'b');
      const nested = await clip('nested.mp4', 'c');
      const turnedDown = await clip('turned-down.mp4', 'd');
      const notMatched = await clip('not-matched.mp4', 'e');
      store.assignTags([tagged.fingerprint], ['dance']);
      store.assignTags([nested.fingerprint], ['dance/bellydance']);
      store.dismissTagSuggestion([turnedDown.fingerprint], 'dance');
      store.assignTags([notMatched.fingerprint], ['sea']);

      const names = (snapshot) => snapshot.records.map((record) => record.relativePath).sort();
      const promptKeys = [pk('a'), pk('b'), pk('c'), pk('d')];
      expect(names(store.getTaggedLibrarySnapshot({ promptKeys, mightBeTag: 'Dance' }))).toEqual([
        'open.mp4',
      ]);
      // A tag under it still might be: clips tagged "dance" can be "bellydance".
      expect(
        names(store.getTaggedLibrarySnapshot({ promptKeys, mightBeTag: 'bellydance' }))
      ).toEqual(['open.mp4', 'tagged.mp4', 'turned-down.mp4']);
      expect(names(store.getTaggedLibrarySnapshot({ promptKeys }))).toHaveLength(4);
    });
  });
}
