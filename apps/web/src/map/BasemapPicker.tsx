// The basemap picker: a small button in the map's bottom-left corner, beside the zoom buttons,
// that opens a list of the four basemaps with a tick on the one on show. Arrow keys move through
// the list, Enter or Space picks, Escape or a click elsewhere closes it.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { chooseBasemap, useShownBasemap } from './basemap-choice.ts';
import { BASEMAPS } from './basemaps.ts';
import './basemap-picker.css';

/** Two stacked sheets: the usual sign for "map layers". */
const LAYERS_ICON = (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <path
      d="M10 3 2.5 7 10 11l7.5-4L10 3Zm-7.5 7L10 14l7.5-4M2.5 13 10 17l7.5-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

export function BasemapPicker() {
  const shown = useShownBasemap();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // A click anywhere else closes the list.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);

  // Opening the list puts the keyboard on the basemap on show.
  useEffect(() => {
    if (open) boxRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(boxRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  };

  const current = BASEMAPS.find((b) => b.id === shown);
  return (
    <div className="basemap-picker" ref={boxRef}>
      {open && (
        <div className="basemap-list" role="menu" aria-label="Basemap" onKeyDown={onListKey}>
          {BASEMAPS.map((b) => (
            <button
              key={b.id}
              role="menuitemradio"
              aria-checked={b.id === shown}
              className={`basemap-item${b.id === shown ? ' on' : ''}`}
              title={b.hint}
              onClick={() => {
                close();
                if (b.id !== shown) chooseBasemap(b.id);
              }}
            >
              <span className="basemap-tick" aria-hidden="true">
                {b.id === shown ? '✓' : ''}
              </span>
              {b.name}
            </button>
          ))}
        </div>
      )}
      <button
        ref={buttonRef}
        className="basemap-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Basemap: ${current?.name ?? shown}. Choose another`}
        title="Choose the basemap: light, streets, dark or satellite"
        onClick={() => setOpen((o) => !o)}
      >
        {LAYERS_ICON}
      </button>
    </div>
  );
}
