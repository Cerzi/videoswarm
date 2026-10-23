# Archived Folders

Status: **Implemented** (2026-10-23).

## Summary

A library collects folders of old generations that nobody means to rate.
They still turn up wherever Video Swarm looks across the whole library, most
of all in the rating arena. *Archiving* a folder leaves its clips out of
those library-wide places, without touching the files, their ratings, tags
or review decisions. Unarchiving brings them straight back.

Asked for by the user on 2026-10-23: old generations "cropping up in the
arena mode", to be ignored completely.

## 1. What an archive leaves out

A clip is archived when its path is under an archived folder. Archived clips
are left out of:

- **the rating arena** (`rating-arena.md`, Section 2): over the library, and
  over the grid's clips. One exception: when the grid's clips are *all*
  archived, they are rated anyway, because opening an archived folder and
  starting the arena there means rating it;
- **an entire-library search** (Filters › Entire library, tag views,
  library smart views);
- **view feeds** and **a clip's smart views in Details** (`view-feeds.md`):
  the feed's pool is the library less the archive, so a smart view another
  app follows never hands it an archived clip, and an archived clip is in no
  smart view;
- **prompt search over the library**, and so Filters › Might be.

Opening an archived folder still shows its clips: the archive is about what
turns up uninvited, not about hiding a folder the user opens on purpose. The
folder grid, its review mode and native file actions work there as before.

Left as they are: the catalog and its metadata, the local read API (it
answers about paths the caller names), tag suggestions' training (tags the
user gave are evidence, wherever the clip lives), and generation versions
(a version in an archived folder is still a version).

## 2. Storage

`archived_folders (prefix TEXT PRIMARY KEY, archived_at)` in the profile
database. `prefix` is the folder's absolute path ending in the path
separator, so `old/` never matches `older/`. Queries test
`substr(absolute_path, 1, length(prefix)) = prefix` (`notArchived` in
`main/database.js`). Matching by absolute path rather than by root means a
folder indexed inside another indexed folder is archived under both roots.

Archiving a folder takes in the folders already archived under it. A folder
under an archived one cannot be archived or brought back on its own: it
follows its parent.

## 3. Interface

- **Folders tree:** each row offers *Archive* on hover; an archived folder is
  dimmed, badged *archived*, and keeps an *Unarchive* button. Folders under
  it are badged too and have no button.
- **Archived folders:** a collapsed list at the end of the library panel,
  also on the home screen, names every archived folder with *Unarchive*, so
  a folder can come back without being opened.
- A toast says what an archive does; an open library search reads again.

IPC: `library:list-archived` (`{ folders, inRoot, rootCovered }` when a
root is named: its archived tree paths, "" for the root itself, and whether
a folder above it is archived) and `library:set-archived` (a root and tree
path, or an archived folder's own path to bring it back). Preload:
`library.listArchived` and `library.setArchived`.

## Where it lives

- `main/database.js`: the table, `notArchived`, `listArchivedFolders`,
  `setFolderArchived`, and the queries that use it.
- `main.js`: the two IPC handlers.
- `src/app/hooks/useArchivedFolders.js`: state for the renderer.
- `src/components/LibrarySidebar.jsx`: the tree buttons and the list.
- Tests: `main/__tests__/archivedFolders.test.js`,
  `src/components/LibrarySidebar.test.jsx`,
  `src/app/hooks/useArchivedFolders.test.js`, and
  `tests/electron/library-view.smoke.spec.cjs`.
