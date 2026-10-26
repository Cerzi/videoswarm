# Projects

Status: **Implemented** — the store, the Projects section in the Library
sidebar, the right-click "Add to project" menu, the library-wide project
view, removal from an open project and archiving are built and verified. A
few smaller items stay open; see *Open items* below.
Last updated: 2026-10-26

## Summary

A **project** is a named, unordered, hand-picked group of clips that belongs
to no folder. It exists for the workflow where a batch of clips is generated
for a particular piece of work and has to be found again as a group later,
wherever the files have since been moved.

Before this, the two ways to do that were both workarounds:

- **A one-off tag.** Tags describe what a clip *is* ("night", "drone",
  "keeper"). A project name describes what the clip was *for*. Using a tag
  for it fills the tag list and its autocomplete with names that are never
  reused, gives the group no lifecycle (a finished project cannot be put
  away), and gives no place that lists "my projects".
- **A dedicated folder.** A clip can live in one folder only, so it cannot
  belong to two projects, and moving files to group them breaks links made
  elsewhere.

## Status convention

Matches the rest of `docs/architecture/`:

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## Where projects sit among the other organizing tools

Each tool answers one question, and the UI copy keeps to these one-line
meanings so the set does not blur:

| Tool | Answers | Membership |
|---|---|---|
| Tags | What is it? | Descriptive, many per clip |
| Rating, review state | How good is it? | One value per clip |
| Smart views | Which clips match these rules? | Recomputed from a saved query |
| **Projects** | **What was it for?** | **Hand-picked, unordered** |
| Sequences | In what order? | Hand-picked, ordered, repeats allowed |

They compose rather than overlap: a project is opened as a collection, the
ordinary filters narrow it ("rated 4 or higher"), and a sequence can be built
from it for the final cut.

### Why not a smart view

A smart view stores rules, not a chosen set. "The 40 clips we made for the
client pitch" has no rule; it is a decision.

### Why not a sequence

Sequences are the nearest existing structure (named, fingerprint-keyed,
library-wide), but they carry order, allow repeats, and cap at 500 entries.
A generation batch can exceed that, and forcing a story order onto clips
that have none makes every add an ordering decision.

### Why not a tag with a `kind` column

The first sketch stored projects as tags with `tags.kind = 'project'`, to
reuse `file_tags` and the tag-view query. Reading the store ruled it out:

- `tags.name` is `UNIQUE COLLATE NOCASE`, and SQLite cannot relax that in
  place, so a project could never share a name with a tag ("night" the tag
  and "Night" the project).
- Tag names are read into every renderer record by at least eight queries
  (cached grid, limited grid, tag view, sequence snapshot, metadata reads,
  `tagUsage`, and more). Each would need a `kind` filter, and missing one
  leaks project names into the tag chips, the filter list and autocomplete.
- `removeTag` deletes a tag row once its last link goes. A project must
  survive being emptied.

Separate tables cost one rekey statement and one snapshot query, and leave
every tag path untouched.

## Naming

The feature is called **Projects** in the UI. "Collection" was the obvious
word but it is already taken: the UI uses it throughout for *whatever is
currently open in the grid* ("Current collection", "Open a collection to save
a smart view", "No videos in this collection"). "Bin" was rejected in the UX
redesign because it reads as the trash.

## 1. Storage

Status: **Implemented**

```sql
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, fingerprint),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (fingerprint) REFERENCES media_content(fingerprint)
    ON DELETE CASCADE
);
```

- **Keyed by content fingerprint, not path**, like tags, ratings, review
  state and sequence entries. Membership follows a clip through renames and
  moves, which is the point of the feature.
- **Membership is a set.** Adding a clip that is already a member is a
  no-op, not an error, so "add the whole selection again" is safe.
- **Byte-identical copies are one member.** Two identical files in different
  folders are one content row; the project view shows every present
  instance, the same as a tag view.
- **The v1 to v2 fingerprint migration carries members across** before the
  source content row is dropped, because the cascade would otherwise empty
  the project silently. Members merge as a union.
- The migration is additive (`CREATE TABLE IF NOT EXISTS`), so existing
  profile databases open unchanged. Projects are profile-local, like every
  other piece of metadata.

Limits: 1,000 projects per profile, 20,000 members per project, names up to
80 characters. A batch that would cross the member cap is refused whole
rather than half-applied.

## 2. Store and IPC surface

Status: **Implemented**

| Store function | IPC channel | Notes |
|---|---|---|
| `listProjects()` | `projects:list` | Every project with `memberCount` and `archived` |
| `createProject(name)` | `projects:create` | Name collision reports `PROJECT_NAME_TAKEN` |
| `renameProject(id, name)` | `projects:rename` | Same collision code |
| `setProjectArchived(id, archived)` | `projects:set-archived` | Archiving keeps members |
| `deleteProject(id)` | `projects:delete` | Members go; clips and their metadata stay |
| `addToProject(id, fingerprints)` | `projects:add` | Unknown fingerprint refuses the whole batch |
| `removeFromProject(id, fingerprints)` | `projects:remove` | Missing members are ignored |
| `getProjectSnapshot(id)` | `projects:snapshot` | Library-wide records, see Section 4 |

The preload bridge exposes these as `window.electronAPI.projects`. Every
handler runs through `runLibraryCatalogOperation`, so a profile switch
mid-call is refused rather than written to the wrong database.

## 3. Sidebar

Status: **Implemented**

A **Projects** section in the Library panel, between Pinned folders and
Smart views:

- `+` opens an inline name form, the same as saving a smart view.
- Each row opens the project and shows its clip count.
- A row's `⋯` offers Rename, Archive (or Restore) and Delete. Delete asks
  for confirmation and says that the clips themselves are not touched.
- Archived projects are hidden behind a "Show archived (n)" toggle, so
  finished work leaves the list without being lost.
- The open project is marked as current.
- The sidebar is shown in a project view even though no folder is open
  (folder views were the only ones that had it), because it is how the user
  moves between projects and finds the one they just named.

## 4. Opening a project

Status: **Implemented**

Opening a project reads a bounded snapshot of every present instance of its
members across every indexed root, and adopts it as a rootless collection
through the same path a library tag view uses (`openTagCollection`). That
gives it, for free, everything a tag view already has: the ordinary
filters, sort and grouping narrow it; review and rating work; playback is
authorized per root on demand; and selection transfers work across roots.

- Like a tag view it is a **snapshot**, not a watched collection. It is
  re-read on open, on refresh, and after a membership change made in the
  app.
- The snapshot reports `missingCount`: members with no present instance
  (deleted, or on a root that is no longer indexed). The sidebar shows it so
  the count of clips in the grid never silently disagrees with the project's
  member count.
- It shares the tag view's 20,000-record and path-byte bounds, and says so
  when they truncate.

## 5. Adding and removing clips

Status: **Implemented**

The clip right-click menu gains a **Project** submenu, acting on the
selection (or the right-clicked clip when nothing else is selected):

- One entry per active project, the 12 most recently changed: "Add to
  *name*". The rest stay reachable from the Library panel.
- "New project with these clips" creates `Project N`, adds the clips and
  opens the Library panel with the new row in rename mode, since naming is
  the step that makes a project findable later.
- While a project is open, "Remove from *name*" removes the clips from it
  and re-reads the view.

Clips that are not indexed yet have no fingerprint and cannot join a
project; the app says so instead of failing silently.

## Open items

- **Membership in Details.** The Details panel does not yet list the
  projects a clip belongs to. It needs a per-fingerprint membership read.
- **Projects in smart views.** A smart view cannot yet say "inside project
  X". The filter definition would need a project field and the library
  scope would need a project-scoped query.
- **Add a generation group.** Clips for a project usually come from the
  same generation runs; "add every version of this clip" would make filling
  a project nearly free.
- **Drag onto a project row** in the sidebar.
- **Library tag views have no sidebar.** Project views now show one; tag
  views still do not. Giving them the same sidebar is a separate change.
