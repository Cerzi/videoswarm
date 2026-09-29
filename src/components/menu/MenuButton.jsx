import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import "./MenuButton.css";

// A button that opens a small menu: the View, ⋯ and Open menus of the top
// bar. Items are data, so what a menu holds stays declarative:
//   { type: "item", id, label, shortcut, onSelect, disabled, hint }
//   { type: "checkbox", id, label, checked, onChange, disabled, hint }
//   { type: "radio", id, label, checked, onSelect, disabled, hint }
//   { type: "heading", id, label } · { type: "separator", id } · { type: "note", id, text }
//   { type: "custom", id, render } for a control that is not a menu item
// Checkbox and radio items keep the menu open, so several can be set in one
// visit; plain items close it.

const INTERACTIVE = new Set(["item", "checkbox", "radio"]);

export default function MenuButton({
  label,
  icon = null,
  items = [],
  ariaLabel,
  title,
  align = "end",
  disabled = false,
  buttonClassName = "toggle-button",
  menuClassName = "",
  menuLabel,
  showCaret = true,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  const focusables = () =>
    [...(menuRef.current?.querySelectorAll('[data-menu-item="true"]:not([disabled])') || [])];

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) close(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (open) focusables()[0]?.focus();
  }, [open]);

  const onMenuKeyDown = (event) => {
    const list = focusables();
    const index = list.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      list[(index + 1) % list.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      list[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      list[list.length - 1]?.focus();
    } else if (event.key === "Tab") {
      close(false);
    }
  };

  const onButtonKeyDown = (event) => {
    if (event.key === "ArrowDown" && !open) {
      event.preventDefault();
      setOpen(true);
    }
  };

  const activate = (item) => {
    if (item.disabled) return;
    if (item.type === "checkbox") {
      item.onChange?.(!item.checked);
      return;
    }
    if (item.type === "radio") {
      item.onSelect?.();
      return;
    }
    close();
    item.onSelect?.();
  };

  const renderItem = (item) => {
    if (item.type === "separator") {
      return <li key={item.id} role="separator" className="menu-button__separator" />;
    }
    if (item.type === "heading") {
      return (
        <li key={item.id} role="presentation" className="menu-button__heading">
          {item.label}
        </li>
      );
    }
    if (item.type === "note") {
      return (
        <li key={item.id} role="presentation" className="menu-button__note">
          {item.text}
        </li>
      );
    }
    if (item.type === "custom") {
      return (
        <li key={item.id} role="presentation" className="menu-button__custom">
          {item.render()}
        </li>
      );
    }
    if (!INTERACTIVE.has(item.type)) return null;
    const role =
      item.type === "checkbox" ? "menuitemcheckbox" : item.type === "radio" ? "menuitemradio" : "menuitem";
    const checked = item.type === "item" ? undefined : Boolean(item.checked);
    return (
      <li key={item.id} role="presentation">
        <button
          type="button"
          role={role}
          aria-checked={checked}
          data-menu-item="true"
          className={`menu-button__item menu-button__item--${item.type}`}
          disabled={item.disabled}
          title={item.hint || undefined}
          onClick={() => activate(item)}
        >
          <span className="menu-button__mark" aria-hidden="true">
            {item.type === "checkbox" ? (checked ? "✓" : "") : item.type === "radio" ? (checked ? "●" : "") : ""}
          </span>
          <span className="menu-button__label">{item.label}</span>
          {item.shortcut ? <kbd className="menu-button__shortcut">{item.shortcut}</kbd> : null}
        </button>
      </li>
    );
  };

  return (
    <div className="menu-button" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`${buttonClassName} menu-button__trigger ${open ? "is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onButtonKeyDown}
      >
        {icon}
        {label ? <span className="menu-button__trigger-label">{label}</span> : null}
        {showCaret ? <span className="menu-button__caret" aria-hidden="true">▾</span> : null}
      </button>
      {open ? (
        <ul
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={menuLabel || ariaLabel || label}
          className={`menu-button__menu menu-button__menu--${align} ${menuClassName}`}
          onKeyDown={onMenuKeyDown}
        >
          {items.filter(Boolean).map(renderItem)}
        </ul>
      ) : null}
    </div>
  );
}
