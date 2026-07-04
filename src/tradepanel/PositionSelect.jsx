// Shared styled dropdown used by the Get Position and Sync Net Positions
// toolbars, so both screens' user/account selectors look identical.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export function CompactSelect({ title, value, options, onChange, disabled = false }) {
  return (
    <label className="positions-compact-select">
      <span>{title}</span>
      <PositionSelect
        value={value}
        onChange={onChange}
        disabled={disabled || !options.length}
        emptyLabel={`No ${title.toLowerCase()}`}
        portal
        options={options.map((option) => ({
          value: option.value,
          label: option.label,
          meta: option.meta,
        }))}
      />
    </label>
  );
}

export function PositionSelect({ value, options, onChange, disabled = false, emptyLabel = 'Select', compact = false, portal = false }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState({});
  const items = options || [];
  const selected = items.find((option) => String(option.value) === String(value));
  const isDisabled = disabled || !items.length;

  useEffect(() => {
    const closeOnOutsideClick = (event) => {
      if (menuRef.current?.contains(event.target)) return;
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, []);

  useLayoutEffect(() => {
    if (!open || !portal) return undefined;

    const updatePosition = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;

      const viewportPad = 8;
      const width = rect.width;
      const left = Math.min(
        Math.max(viewportPad, rect.left),
        window.innerWidth - width - viewportPad,
      );

      setMenuStyle({
        position: 'fixed',
        top: `${rect.bottom + 5}px`,
        left: `${left}px`,
        width: `${width}px`,
        zIndex: 6000, // above the filter popover (3000) and strategy dialog (4200)
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, portal]);

  const choose = (nextValue) => {
    onChange(nextValue);
    setOpen(false);
  };

  const menu = open && (
    <div
      ref={menuRef}
      className={`position-select-menu${portal ? ' position-select-menu-portal' : ''}`}
      style={portal ? menuStyle : undefined}
      role="listbox"
    >
      {items.map((option) => {
        const active = String(option.value) === String(value);
        return (
          <button
            key={option.value}
            className={`position-select-option${active ? ' active' : ''}`}
            type="button"
            role="option"
            aria-selected={active}
            onClick={() => choose(option.value)}
          >
            <span>
              {option.meta && <em>{option.meta}</em>}
              <strong>{option.label}</strong>
            </span>
            {active && <Check size={14} />}
          </button>
        );
      })}
    </div>
  );

  return (
    <div ref={wrapRef} className={`position-select${compact ? ' compact' : ''}${open ? ' open' : ''}${isDisabled ? ' disabled' : ''}`}>
      <button
        className="position-select-trigger"
        type="button"
        disabled={isDisabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="position-select-text">
          {selected?.meta && <em>{selected.meta}</em>}
          <strong>{selected?.label || emptyLabel}</strong>
        </span>
        <ChevronDown className="position-select-caret" size={15} />
      </button>
      {portal ? createPortal(menu, document.body) : menu}
    </div>
  );
}
