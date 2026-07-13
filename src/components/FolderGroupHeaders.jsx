import React, { useMemo } from "react";
import { flattenExpandedFolderTree } from "../library/folderModel";
import "./LibraryNavigation.css";

function FolderGroupHeaders({ tree, currentPath = "", onSelectFolder }) {
  const groups = useMemo(() => {
    if (!tree) return [];
    const expandAll = new Set();
    const stack = [tree];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      expandAll.add(node.path || "");
      stack.push(...(node.children || []));
    }
    return flattenExpandedFolderTree(tree, expandAll)
      .map(({ node }) => node)
      .filter((node) => node.path && Number(node.directMatchingCount) > 0);
  }, [tree]);

  if (!groups.length) return null;

  return (
    <nav className="folder-group-headers" aria-label="Visible folder groups">
      <span className="folder-group-headers__label">Folder groups</span>
      <div className="folder-group-headers__list">
        {groups.map((node) => (
          <button
            key={node.path}
            type="button"
            className={node.path === currentPath ? "is-current" : ""}
            onClick={() => onSelectFolder?.(node.path, node)}
            title={node.path}
          >
            <span>{node.path}</span>
            <span>{Number(node.directMatchingCount).toLocaleString()}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

export default React.memo(FolderGroupHeaders);
