import React from "react";

function Icon({ children, ...props }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function SortAscendingIcon(props) {
  return (
    <Icon {...props}>
      <path d="M4 6h9" />
      <path d="M4 12h6" />
      <path d="M4 18h3" />
      <path d="M17 5v14" />
      <path d="m14 16 3 3 3-3" />
    </Icon>
  );
}

export function SortDescendingIcon(props) {
  return (
    <Icon {...props}>
      <path d="M4 6h3" />
      <path d="M4 12h6" />
      <path d="M4 18h9" />
      <path d="M17 5v14" />
      <path d="m14 8 3-3 3 3" />
    </Icon>
  );
}

export function DockPanelIcon(props) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="m15 9-3 3 3 3" />
    </Icon>
  );
}

export function UndockPanelIcon(props) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="m13 9 3 3-3 3" />
    </Icon>
  );
}

export function FocusSelectionIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3" />
      <path d="M12 19v3" />
      <path d="M2 12h3" />
      <path d="M19 12h3" />
      <path d="M5 5l2 2" />
      <path d="m17 17 2 2" />
      <path d="m19 5-2 2" />
      <path d="m7 17-2 2" />
    </Icon>
  );
}

export function EraserIcon(props) {
  return (
    <Icon {...props}>
      <path d="m7 21-4-4 10-10 4 4Z" />
      <path d="m14 6 3-3 4 4-3 3" />
      <path d="M9 19h12" />
    </Icon>
  );
}

export function RefreshIcon(props) {
  return (
    <Icon {...props}>
      <path d="M20 7v5h-5" />
      <path d="M4 17v-5h5" />
      <path d="M6.1 9a7 7 0 0 1 11.7-2.6L20 9" />
      <path d="m4 15 2.2 2.6A7 7 0 0 0 17.9 15" />
    </Icon>
  );
}

export function PlusIcon(props) {
  return (
    <Icon {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  );
}

export function ReviewModeIcon(props) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="m7.5 12 3 3 6-7" />
    </Icon>
  );
}

export function CopyIcon(props) {
  return (
    <Icon {...props}>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </Icon>
  );
}

export function MoveIcon(props) {
  return (
    <Icon {...props}>
      <path d="M5 12h13" />
      <path d="m14 8 4 4-4 4" />
      <path d="M5 7v10" />
    </Icon>
  );
}
