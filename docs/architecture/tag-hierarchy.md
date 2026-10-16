# Tag Hierarchy

Status: **Implemented, unverified by a human** (2026-10-17)

## Summary

A tag may sit under one parent: `bellydance` under `dance`. Asking for a tag
means that tag and every tag under it. Filtering by `dance` finds clips tagged
`bellydance`, and a library view of `dance` does too. A clip still carries only
the tags applied to it.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## Model

- `tags.parent_id` references another tag, or is null at the top level. It is
  added by the schema check; existing tags start at the top level.
- **Ancestors are derived, never stored on clips.** Moving a tag moves every
  clip under it at once, and removing a parent link rewrites nothing.
- **One parent per tag.** A tree covers the reported need and keeps counts and
  display unambiguous. Several parents (a DAG) are deferred until a real
  taxonomy needs them; the column can widen to a link table then.
- At most **eight levels**. Setting a parent refuses a cycle, a tag under
  itself, and a deeper tree.
- A tag is deleted once nothing is tagged with it and nothing sits under it. A
  parent kept only for its children goes with the last of them.

## Behaviour

- **Counts.** `listTags()` returns `usageCount`, the distinct present clips
  tagged with the tag or any tag under it, and `directCount`, its own. A clip
  with two tags under `dance` counts once toward `dance`.
- **Folder filters** (`useFilterState`) and **library views**
  (`getTaggedLibrarySnapshot`) match through the tree. In an "all" match each
  requested tag is one group, so two tags under `dance` do not also satisfy
  `outdoor`.
- **Typing `dance/bellydance`** in any tag input applies `bellydance` and puts
  it under `dance`, creating either as needed. No existing tag name contained
  `/` when this was introduced.
- **Filters › Tags** shows where a nested tag sits ("in dance") and has a
  **Parent** action that moves a tag under another, or back to the top level.
  It shows a refused move's reason in place.
- Tag matches under the tag input show a tag's parent.

## Acceptance

- Filtering, excluding and library views by a parent include its descendants;
  a child still means only itself.
- Counts are distinct across a subtree and exclude missing clips.
- Cycles, self-parenting and a ninth level are refused with a reason.
- A parent-only tag survives while it has children and goes with the last.

## Deferred

- Several parents per tag.
- Showing the tree itself (indentation, collapse) in the Filters tag list.
- Renaming or merging tags.
