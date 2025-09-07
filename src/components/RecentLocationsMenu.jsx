import React from "react";

export default function RecentLocationsMenu({ items, onOpen }) {
  if (!items?.length) return null;
  return (
    <select
      className="select-control"
      onChange={(e) => {
        const path = e.target.value;
        if (path) onOpen(path);
        e.target.value = "";
      }}
      title="Open recent folder"
    >
      <option value="">Recent…</option>
      {items.map((it) => (
        <option key={it.path} value={it.path}>
          {it.name}
        </option>
      ))}
    </select>
  );
}
