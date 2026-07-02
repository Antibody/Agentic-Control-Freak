"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

export interface SelectMenuOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  tone?: "default" | "accent" | "danger";
}

interface SelectMenuProps<T extends string> {
  value: T;
  options: SelectMenuOption<T>[];
  onSelect: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  align?: "start" | "end";
  className?: string;
}

export function SelectMenu<T extends string>({
  value,
  options,
  onSelect,
  ariaLabel,
  disabled = false,
  align = "end",
  className,
}: SelectMenuProps<T>): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const current = options.find((option) => option.value === value) ?? options[0];
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  const close = useCallback((focusTrigger: boolean): void => {
    setOpen(false);
    setActiveIndex(-1);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']");
    items?.[activeIndex]?.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointer = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("mousedown", handlePointer);
    return () => document.removeEventListener("mousedown", handlePointer);
  }, [open]);

  const choose = (next: T): void => {
    onSelect(next);
    close(true);
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event: React.KeyboardEvent): void => {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % options.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + options.length) % options.length);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Tab":
        setOpen(false);
        setActiveIndex(-1);
        break;
      default:
        break;
    }
  };

  return (
    <div ref={rootRef} className={`select-menu${className !== undefined ? ` ${className}` : ""}${open ? " select-menu-open" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="select-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${ariaLabel}: ${current?.label ?? ""}`}
        title={`${ariaLabel}: ${current?.label ?? ""}${current?.description !== undefined ? ` — ${current.description}` : ""}`}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onTriggerKeyDown}
      >
        {current?.icon !== undefined ? <span className="select-menu-icon" aria-hidden>{current.icon}</span> : null}
        <span className="select-menu-current">{current?.label}</span>
        <svg className="select-menu-caret" viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          className={`select-menu-pop select-menu-pop-${align}`}
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={onMenuKeyDown}
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                tabIndex={-1}
                className={`select-menu-option${selected ? " select-menu-option-selected" : ""}${option.tone !== undefined ? ` select-menu-option-${option.tone}` : ""}`}
                onClick={() => choose(option.value)}
              >
                {option.icon !== undefined ? <span className="select-menu-option-icon" aria-hidden>{option.icon}</span> : null}
                <span className="select-menu-option-text">
                  <span className="select-menu-option-label">{option.label}</span>
                  {option.description !== undefined ? (
                    <span className="select-menu-option-desc">{option.description}</span>
                  ) : null}
                </span>
                <span className="select-menu-check" aria-hidden>
                  {selected ? (
                    <svg viewBox="0 0 14 14" width="13" height="13">
                      <path d="M2.5 7.4 6 10.5 11.5 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
