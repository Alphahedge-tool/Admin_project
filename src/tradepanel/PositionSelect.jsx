// Shared styled dropdown used by the Get Position and Sync Net Positions
// toolbars, so both screens' user/account selectors look identical.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, UsersRound } from 'lucide-react';
import { BrokerMark } from './BrokerMark';
import { hasBrokerArtwork } from './brokerArtwork';

// Below this many options the list is short enough to read at a glance, and a
// search box would be more chrome than help. At or above it, scrolling to find a
// client starts to cost more than typing two letters.
const SEARCH_THRESHOLD = 8;

export function CompactSelect({ title, value, options, onChange, disabled = false, menuMinWidth = 0, className = '', icon = '' }) {
  return (
    <label className={`positions-compact-select${className ? ` ${className}` : ''}`}>
      <span>{title}</span>
      <PositionSelect
        value={value}
        onChange={onChange}
        disabled={disabled || !options.length}
        emptyLabel={`No ${title.toLowerCase()}`}
        portal
        icon={icon}
        menuMinWidth={menuMinWidth}
        options={options.map((option) => ({
          value: option.value,
          label: option.label,
          meta: option.meta,
          brokerName: option.brokerName,
        }))}
      />
    </label>
  );
}

// Two initials off a label, for the avatar chip. "NP Berlia" -> NP,
// "SEYH1006" -> SE, so a client list stays visually distinguishable at a glance.
function optionInitials(label = '') {
  const words = String(label).trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return String(label).replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
}

// A broker logo when the option is an account, otherwise the opted-in avatar
// chip. Plain options (sort, grouping, ...) pass no icon and stay text-only.
function OptionMark({ option, icon }) {
  // On an opted-in client/group picker only an explicit brokerName may draw a
  // logo. Sniffing the label here would hand a client called "angel123" the
  // Angel One mark and imply a broker they may not even trade with.
  if (icon) {
    if (option.brokerName && hasBrokerArtwork(option.brokerName)) {
      return <BrokerMark brokerName={option.brokerName} />;
    }
    return (
      <span className="position-select-avatar" aria-hidden="true">
        {icon === 'group' ? <UsersRound size={13} /> : optionInitials(option.label)}
      </span>
    );
  }

  // Account pickers carry their broker in `meta`, so they keep the original
  // name-sniffing fallback.
  return <BrokerMark brokerName={option.brokerName || option.meta || option.label} />;
}

export function PositionSelect({ value, options, onChange, disabled = false, emptyLabel = 'Select', compact = false, portal = false, menuMinWidth = 0, icon = '' }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const searchRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState({});
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const items = useMemo(() => options || [], [options]);
  const selected = items.find((option) => String(option.value) === String(value));
  const isDisabled = disabled || !items.length;
  const showSearch = items.length >= SEARCH_THRESHOLD;

  // Match against the label and the meta tag (broker / account), so typing
  // "kotak" narrows to that broker's accounts just as readily as typing a name.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((option) => (
      `${option.label || ''} ${option.meta || ''} ${option.brokerName || ''}`
        .toLowerCase()
        .includes(needle)
    ));
  }, [items, query]);

  // Opening is an event, not a synchronisation: each open starts from a clean
  // search with the highlight on whatever is currently selected, so Enter is a
  // no-op rather than a surprise re-pick. Done here rather than in an effect
  // keyed on `open` so it costs no extra render pass.
  const openMenu = () => {
    const current = items.findIndex((option) => String(option.value) === String(value));
    setActiveIndex(current >= 0 ? current : 0);
    setQuery('');
    setOpen(true);
  };

  const search = (next) => {
    setQuery(next);
    // Typing invalidates the old highlight position.
    setActiveIndex(0);
  };

  // Focus is a DOM effect, and has to wait for the portal to be placed - doing
  // it any earlier makes the menu jump as it mounts.
  useEffect(() => {
    if (!open || !showSearch) return undefined;
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, showSearch]);

  // Keep the keyboard highlight inside the scroll viewport as it moves.
  useEffect(() => {
    if (!open) return;
    const node = menuRef.current?.querySelectorAll('.position-select-option')[activeIndex];
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

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
      const width = Math.max(rect.width, Number(menuMinWidth || 0));
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
  }, [open, portal, menuMinWidth]);

  const choose = (nextValue) => {
    onChange(nextValue);
    setOpen(false);
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!visible.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => (current + step + visible.length) % visible.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const option = visible[activeIndex];
      if (option) choose(option.value);
    }
  };

  const menu = open && (
    <div
      ref={menuRef}
      className={`position-select-menu${portal ? ' position-select-menu-portal' : ''}${showSearch ? ' has-search' : ''}`}
      style={portal ? menuStyle : undefined}
      onKeyDown={handleKeyDown}
    >
      {showSearch && (
        <div className="position-select-search">
          <Search size={13} />
          <input
            ref={searchRef}
            type="text"
            value={query}
            placeholder="Search..."
            aria-label="Search options"
            onChange={(event) => search(event.target.value)}
          />
          <span className="position-select-search-count">{visible.length}</span>
        </div>
      )}

      <div className="position-select-list" role="listbox">
        {visible.map((option, index) => {
          const active = String(option.value) === String(value);
          return (
            <button
              key={option.value}
              className={`position-select-option${active ? ' active' : ''}${index === activeIndex ? ' highlighted' : ''}`}
              type="button"
              role="option"
              aria-selected={active}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(option.value)}
            >
              <span>
                <OptionMark option={option} icon={icon} />
                {option.meta && <em>{option.meta}</em>}
                <strong>{option.label}</strong>
              </span>
              {active && <Check size={14} />}
            </button>
          );
        })}

        {!visible.length && (
          <p className="position-select-empty">No matches for &ldquo;{query}&rdquo;</p>
        )}
      </div>
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
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          // Closed: Down opens. Open without a search box, focus stays here, so
          // the trigger has to drive the same arrow/Enter navigation the menu
          // handles once the search input has taken focus.
          if (!open) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              openMenu();
            }
            return;
          }
          if (!showSearch) handleKeyDown(event);
        }}
      >
        <span className="position-select-text">
          {selected && <OptionMark option={selected} icon={icon} />}
          {selected?.meta && <em>{selected.meta}</em>}
          <strong>{selected?.label || emptyLabel}</strong>
        </span>
        <ChevronDown className="position-select-caret" size={15} />
      </button>
      {portal ? createPortal(menu, document.body) : menu}
    </div>
  );
}
