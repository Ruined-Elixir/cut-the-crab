import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import "./ToolbarMenu.css";

export type ToolbarMenuItem =
  | {
      kind: "action";
      id: string;
      label: string;
      /** Small secondary text on the right (a shortcut or a count). */
      hint?: string;
      /** "radio" and "checkbox" show a check mark when `checked` is true. */
      role?: "item" | "radio" | "checkbox";
      checked?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: "heading"; id: string; label: string }
  | { kind: "separator"; id: string };

type ToolbarMenuProps = {
  label: string;
  items: ToolbarMenuItem[];
  className?: string;
  title?: string;
};

type Anchor = { left: number; top: number; bottom: number };
type Placement = { left: number; top: number; maxHeight: number };

/*
 * A button that opens a small dropdown. The menu is rendered in a portal so it
 * is never clipped by a toolbar, and it is kept inside the window.
 */
function ToolbarMenu({ label, items, className, title }: ToolbarMenuProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setPlacement(null);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) {
      close(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ left: rect.left, top: rect.top, bottom: rect.bottom });
    setOpen(true);
  };

  // Place the menu once its size is known: below the button if it fits,
  // otherwise above, and never outside the window.
  useLayoutEffect(() => {
    if (!open || !anchor || !menuRef.current) return;
    const menu = menuRef.current;
    const margin = 8;
    const gap = 6;
    const width = menu.offsetWidth;
    const height = menu.scrollHeight;

    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
    const spaceBelow = window.innerHeight - anchor.bottom - gap - margin;
    const spaceAbove = anchor.top - gap - margin;
    const below = height <= spaceBelow || spaceBelow >= spaceAbove;
    const maxHeight = Math.max(120, below ? spaceBelow : spaceAbove);
    const usedHeight = Math.min(height, maxHeight);

    setPlacement({
      left,
      top: below ? anchor.bottom + gap : anchor.top - gap - usedHeight,
      maxHeight,
    });
  }, [open, anchor, items.length]);

  // Move focus into the menu once it is visible.
  useEffect(() => {
    if (!placement || !menuRef.current) return;
    const buttons = Array.from(
      menuRef.current.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)'),
    );
    (buttons.find((button) => button.getAttribute("aria-checked") === "true") ?? buttons[0])?.focus();
  }, [placement]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const onDismiss = () => close(false);

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("blur", onDismiss);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("blur", onDismiss);
    };
  }, [open, close]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)'),
    );
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);

    if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[(index + 1) % buttons.length].focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      buttons[(index - 1 + buttons.length) % buttons.length].focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      buttons[0].focus();
    } else if (event.key === "End") {
      event.preventDefault();
      buttons[buttons.length - 1].focus();
    } else if (event.key === "Tab") {
      close(false);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`tb-menu-button${open ? " open" : ""}${className ? ` ${className}` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={title}
        onClick={toggle}
      >
        <span>{label}</span>
        <svg className="tb-menu-caret" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            className="tb-menu-popover"
            style={
              placement
                ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight }
                : { left: 0, top: 0, visibility: "hidden" }
            }
            onKeyDown={onMenuKeyDown}
            onContextMenu={(event) => event.preventDefault()}
          >
            {items.map((item) => {
              if (item.kind === "separator") {
                return <div key={item.id} className="tb-menu-separator" role="separator" />;
              }
              if (item.kind === "heading") {
                return (
                  <div key={item.id} className="tb-menu-heading" role="presentation">
                    {item.label}
                  </div>
                );
              }

              const role =
                item.role === "radio"
                  ? "menuitemradio"
                  : item.role === "checkbox"
                    ? "menuitemcheckbox"
                    : "menuitem";

              return (
                <button
                  key={item.id}
                  type="button"
                  role={role}
                  aria-checked={role === "menuitem" ? undefined : Boolean(item.checked)}
                  disabled={item.disabled}
                  className="tb-menu-item"
                  onClick={() => {
                    close(true);
                    item.onSelect();
                  }}
                >
                  <span className="tb-menu-check" aria-hidden="true">
                    {item.checked ? "✓" : ""}
                  </span>
                  <span className="tb-menu-label">{item.label}</span>
                  {item.hint && <span className="tb-menu-hint">{item.hint}</span>}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

export default ToolbarMenu;
