import { useCallback, useEffect, useId, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
  /** Secondary right-aligned text (e.g. "193 GB free"). */
  hint?: string;
}

/**
 * Themed dropdown replacing the native <select> popup. ARIA listbox
 * contract: arrows/Home/End open & rove, Enter/Space pick, Esc refocuses
 * the trigger, Tab closes, pointer-down outside / focus-leaving closes.
 * Flips up when there's no room below; entry animation is
 * prefers-reduced-motion-safe.
 */
export function AppSelect({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  minWidth = 240,
  fullWidth = false,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  minWidth?: number;
  /** Stretch the trigger to its container's width (block layout). */
  fullWidth?: boolean;
}) {
  const menuId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"bottom" | "top">("bottom");
  const [active, setActive] = useState(0);

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const selected = options[selectedIndex];

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(
    (index: number) => {
      const trigger = triggerRef.current;
      if (trigger) {
        const rect = trigger.getBoundingClientRect();
        const est = options.length * 34 + 12;
        const below = window.innerHeight - rect.bottom;
        setSide(below < est && rect.top > below ? "top" : "bottom");
      }
      setActive(index);
      setOpen(true);
    },
    [options.length],
  );

  const pick = useCallback(
    (index: number) => {
      const opt = options[index];
      if (opt) onChange(opt.value);
      close(true);
    },
    [options, onChange, close],
  );

  // Focus the listbox on open + keep the active option scrolled into view.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.focus();
    menuRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // Outside pointer-down + focus-leaving close.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onFocus = (e: FocusEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.relatedTarget as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("focusin", onFocus, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("focusin", onFocus, true);
    };
  }, [open]);

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openMenu(
        e.key === "ArrowDown"
          ? Math.min(selectedIndex + 1, options.length - 1)
          : Math.max(selectedIndex - 1, 0),
      );
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      openMenu(e.key === "Home" ? 0 : options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) pick(active);
      else openMenu(selectedIndex);
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <span ref={wrapRef} className={`relative ${fullWidth ? "block w-full" : "inline-block"}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        onClick={() => {
          if (options.length === 0) return;
          if (open) close(false);
          else openMenu(selectedIndex);
        }}
        onKeyDown={onTriggerKeyDown}
        className="flex w-full items-center justify-between gap-3 rounded-md border border-edge bg-raise px-3 py-2 text-[13px] text-fg transition-colors hover:border-mut/50 disabled:opacity-40"
        style={{ minWidth }}
      >
        <span className="truncate font-mono text-[12.5px]">{selected?.label ?? "--"}</span>
        <span className="flex items-center gap-2 text-mut">
          {selected?.hint ? <span className="text-[11.5px]">{selected.hint}</span> : null}
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            aria-hidden
            className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          >
            <path
              d="M2.5 4.5 6 8l3.5-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {open ? (
        <ul
          ref={menuRef}
          id={menuId}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={`${menuId}-opt-${active}`}
          tabIndex={-1}
          data-side={side}
          onKeyDown={onMenuKeyDown}
          className={`u-menu-in absolute left-0 z-50 max-h-72 overflow-y-auto rounded-md border border-edge bg-panel py-1 outline-none ${fullWidth ? "right-0" : ""}`}
          style={{
            minWidth,
            ...(side === "bottom" ? { top: "calc(100% + 6px)" } : { bottom: "calc(100% + 6px)" }),
          }}
        >
          {options.map((opt, i) => {
            const isSel = opt.value === value;
            const isActive = i === active;
            return (
              <li
                key={opt.value}
                id={`${menuId}-opt-${i}`}
                role="option"
                aria-selected={isSel}
                data-index={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(i)}
                className={`flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[13px] ${
                  isActive ? "bg-raise" : ""
                } ${isSel ? "text-fg" : "text-mut"}`}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 13 13"
                  aria-hidden
                  className={isSel ? "text-accent" : "opacity-0"}
                >
                  <path
                    d="M2 7 5 10l6-7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{opt.label}</span>
                {opt.hint ? <span className="text-[11.5px] text-mut">{opt.hint}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </span>
  );
}
