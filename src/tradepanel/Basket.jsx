import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Minus, X, Link2, Copy, Trash2, Pencil, Info, Eye, Bookmark, BarChart3, RefreshCw } from 'lucide-react';

// Basket panel — collects option legs the user clicks (Buy/Sell) from the
// option chain and lays them out like a multi-leg order ticket. UI only: no
// order is placed and the footer actions are not wired to any API yet.
//
// Props:
//   legs        : array of leg objects (see makeLeg in main.jsx for shape)
//   name        : basket name shown in the title bar
//   maxOrders   : cap shown as "(n / maxOrders Orders)"
//   onRemoveLeg : (id) => void          remove one leg
//   onUpdateLeg : (id, patch) => void   patch a leg field
//   onClear     : () => void            clear the whole basket
//   onClose     : () => void            close/hide the basket panel
export default function Basket({
  legs = [],
  name = 'BASKET',
  maxOrders = 50,
  margin = { status: 'idle', value: 0, message: '' },
  charges = { status: 'idle', value: 0, message: '' },
  expiryIndex = {},
  liveTicks = {},
  onRemoveLeg,
  onUpdateLeg,
  onResolveLeg,
  onStepStrike,
  onRefreshMargin,
  onPlaceBasket,
  onClear,
  onClose,
  onAddLeg,
  className = '',
}) {
  const [multiplier, setMultiplier] = useState('1');
  const [basketName, setBasketName] = useState(name);
  const [editingName, setEditingName] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [placeResult, setPlaceResult] = useState(null);
  const [placeError, setPlaceError] = useState('');
  const allChecked = legs.length > 0 && legs.every((leg) => leg.selected !== false);
  const selectedLegs = legs.filter((leg) => leg.selected !== false);

  async function confirmOrders() {
    setPlacing(true);
    setPlaceError('');
    setPlaceResult(null);
    try {
      const result = await onPlaceBasket?.();
      setPlaceResult(result || null);
    } catch (error) {
      setPlaceError(error.message || 'Order placement failed');
    } finally {
      setPlacing(false);
    }
  }

  // Turn a search result into a fully-resolved basket leg (token already known,
  // so no /resolve-leg round-trip needed). Live LTP arrives once the feed picks
  // up the token via the basket-tokens sync.
  function addFromSearch(r) {
    onAddLeg?.({
      symbol: r.name,
      tradingSymbol: r.tradingSymbol,
      expiry: r.expiry,
      exchange: r.exchange,
      lotSize: Number(r.lotSize) || 1,
      strike: r.instrument === 'FUT' ? 0 : Number(r.strike) || 0,
      optionType: r.optionType, // CE | PE | FUT
      instrument: r.instrument, // OPT | FUT
      action: 'BUY',
      product: 'CF',
      qty: 1,
      price: '',
      priceType: 'MARKET',
      ltp: null,
      close: null,
      changePct: null,
      token: r.token,
      selected: true,
    });
  }

  function toggleAll(checked) {
    legs.forEach((leg) => onUpdateLeg?.(leg.id, { selected: checked }));
  }

  // Lot/Quantity Multiplier acts as a direct setter: set it to N and every leg's
  // Quantity becomes N lots. Margin/charges follow automatically (they read qty).
  // The field holds a raw string so it can be cleared and retyped freely; we only
  // push a qty to the legs when the value parses to a positive integer.
  function applyMultiplier(value) {
    setMultiplier(String(value));
    const qty = Math.trunc(Number(value));
    if (Number.isFinite(qty) && qty >= 1) {
      legs.forEach((leg) => onUpdateLeg?.(leg.id, { qty }));
    }
  }

  // On blur, snap an empty/invalid field back to a valid multiplier of 1.
  function commitMultiplier() {
    const qty = Math.max(1, Math.trunc(Number(multiplier) || 1));
    setMultiplier(String(qty));
    legs.forEach((leg) => onUpdateLeg?.(leg.id, { qty }));
  }

  return (
    <section className={`basket-panel ${className}`.trim()} aria-label="Order basket">
      {/* ── Title bar: name · order count · search · window actions ── */}
      <header className="basket-titlebar">
        <div className="basket-title">
          {editingName ? (
            <input
              className="basket-name-input"
              type="text"
              autoFocus
              value={basketName}
              onChange={(event) => setBasketName(event.target.value)}
              onBlur={() => setEditingName(false)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setEditingName(false);
                if (event.key === 'Escape') { setBasketName(name); setEditingName(false); }
              }}
            />
          ) : (
            <span className="basket-name">{basketName || 'UNTITLED BASKET'}</span>
          )}
          <button
            className="basket-rename"
            type="button"
            title="Rename basket"
            onClick={() => setEditingName(true)}
          >
            <Pencil size={13} />
          </button>
          <span className="basket-count">({legs.length} / {maxOrders} Orders)</span>
        </div>
        <BasketSearch onAdd={addFromSearch} />
        <div className="basket-window-actions">
          <button className="basket-window-btn" type="button" title="Minimise"><Minus size={15} /></button>
          <button className="basket-window-btn" type="button" title="Close basket" onClick={onClose}><X size={15} /></button>
        </div>
      </header>

      {/* ── Column headings ── */}
      <div className="basket-colhead">
        <span className="bc-check">
          <input type="checkbox" checked={allChecked} onChange={(event) => toggleAll(event.target.checked)} aria-label="Select all legs" />
        </span>
        <span className="bc-stock">Stock</span>
        <span className="bc-action">Action</span>
        <span className="bc-expiry">Expiry Date</span>
        <span className="bc-strike">Strike Price</span>
        <span className="bc-cepe">CE/PE</span>
        <span className="bc-product">Product</span>
        <span className="bc-qty">Quantity</span>
        <span className="bc-price">Price/Price Type</span>
      </div>

      {/* ── Leg rows ── */}
      <div className="basket-rows">
        {legs.map((leg) => (
          <BasketRow
            key={leg.id}
            leg={leg}
            liveTick={leg.token != null ? liveTicks[leg.token] : null}
            expiries={expiryIndex[leg.symbol] || []}
            onRemoveLeg={onRemoveLeg}
            onUpdateLeg={onUpdateLeg}
            onResolveLeg={onResolveLeg}
            onStepStrike={onStepStrike}
          />
        ))}
      </div>

      {/* ── Margin / multiplier strip ── Required margin is the real figure
           from Angel's batch margin calculator (spread benefits netted). ── */}
      <div className="basket-marginstrip">
        <span className="basket-margin">
          <span className="basket-stat-label">Required Margin</span>
          <strong className={marginClass(margin.status, margin.value)} title={margin.message || ''}>
            {renderMargin(margin)}
          </strong>
          <button
            type="button"
            className="basket-margin-refresh"
            title="Refresh margin at current prices"
            onClick={onRefreshMargin}
            disabled={!legs.length || margin.status === 'loading'}
          >
            <RefreshCw size={13} className={margin.status === 'loading' ? 'spin' : ''} aria-hidden="true" />
          </button>
        </span>
        <label className="basket-multiplier">
          Lot/Quantity Multiplier
          <span className="basket-step">
            <input
              type="number"
              min="1"
              value={multiplier}
              onChange={(event) => applyMultiplier(event.target.value)}
              onBlur={commitMultiplier}
            />
            <span className="basket-step-arrows">
              <button type="button" tabIndex={-1} title="Increase lots" onClick={() => applyMultiplier((Math.trunc(Number(multiplier)) || 0) + 1)}>▲</button>
              <button type="button" tabIndex={-1} title="Decrease lots" onClick={() => applyMultiplier(Math.max(1, (Math.trunc(Number(multiplier)) || 1) - 1))}>▼</button>
            </span>
          </span>
        </label>
      </div>

      {/* ── Footer: charges + actions (UI only) ── */}
      <footer className="basket-footer">
        <span className="basket-charges">
          <span className="basket-stat-label">Total Charges</span>
          <strong className={marginClass(charges.status)} title={charges.message || ''}>
            {renderMargin(charges)}
          </strong>
          <span className="basket-charges-tip">
            <Info className="basket-charges-info" size={14} aria-hidden="true" />
            {charges.status === 'ready' && Array.isArray(charges.breakup) && charges.breakup.length > 0 && (
              <ChargesPopover breakup={charges.breakup} total={charges.value} />
            )}
          </span>
        </span>
        <div className="basket-footer-actions">
          {legs.length > 0 && (
            <button className="basket-btn ghost" type="button" onClick={onClear}>
              <Trash2 size={14} aria-hidden="true" />
              Clear
            </button>
          )}
          <button className="basket-btn analyse" type="button" onClick={onRefreshMargin}>
            <BarChart3 size={15} aria-hidden="true" />
            ANALYSE
          </button>
          <button className="basket-btn save" type="button">
            <Bookmark size={15} aria-hidden="true" />
            SAVE BASKET
          </button>
          <button
            className="basket-btn preview"
            type="button"
            disabled={!selectedLegs.length}
            onClick={() => { setPlaceResult(null); setPlaceError(''); setPreviewOpen(true); }}
          >
            <Eye size={15} aria-hidden="true" />
            PREVIEW BASKET
          </button>
        </div>
      </footer>
      {previewOpen && (
        <OrderPreviewModal
          name={basketName || name}
          legs={selectedLegs}
          margin={margin}
          charges={charges}
          placing={placing}
          result={placeResult}
          error={placeError}
          onAnalyse={onRefreshMargin}
          onEdit={() => setPreviewOpen(false)}
          onClose={() => setPreviewOpen(false)}
          onConfirm={confirmOrders}
        />
      )}
    </section>
  );
}

// A single leg row. Mirrors the screenshot columns: select, stock+LTP, action
// (B/S pill), expiry, strike, CE/PE, product, quantity stepper, price + a
// LIMIT/MARKET toggle.
function BasketRow({ leg, liveTick, expiries = [], onRemoveLeg, onUpdateLeg, onResolveLeg, onStepStrike }) {
  const isSell = leg.action === 'SELL';
  const orderType = String(leg.priceType || 'MARKET').toUpperCase();
  const isMarket = orderType === 'MARKET' || orderType === 'SL-M';
  const needsTrigger = orderType === 'SL' || orderType === 'SL-M';
  // Strike is edited in LOCAL state so typing doesn't mutate leg.strike on every
  // keystroke — that used to defeat the "did the strike change?" guard on blur
  // (leg.strike already equalled the typed value, so the re-resolve never
  // fired). We commit via onResolveLeg on Enter/blur and re-sync when the leg's
  // resolved strike changes (e.g. an off-grid strike snapped, or an expiry
  // change re-resolved to a nearby strike).
  const [strikeInput, setStrikeInput] = useState(leg.strike ?? '');
  useEffect(() => { setStrikeInput(leg.strike ?? ''); }, [leg.strike]);
  // Live LTP from the feed (every leg is subscribed, so this ticks even for
  // legs off the on-screen chain). Falls back to the value captured at add/
  // resolve time, and finally to the day's close so a leg with no live price
  // (market closed / quote failed) still shows a real number instead of a dash.
  const liveLtp = liveTick?.ltp;
  const hasLive = liveLtp != null && liveLtp > 0;
  const usingClose = !hasLive && !(leg.ltp > 0) && leg.close > 0;
  const ltp = hasLive ? liveLtp : (leg.ltp > 0 ? leg.ltp : (leg.close ?? leg.ltp));
  const changePct = (liveTick && liveTick.ltp != null && liveTick.close)
    ? Number((((liveTick.ltp - liveTick.close) / liveTick.close) * 100).toFixed(2))
    : leg.changePct;
  const chg = Number(changePct);
  const chgClass = chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';

  return (
    <div className={`basket-row${isSell ? ' sell-leg' : ''}`}>
      <span className="bc-check">
        <input
          type="checkbox"
          checked={leg.selected !== false}
          onChange={(event) => onUpdateLeg?.(leg.id, { selected: event.target.checked })}
          aria-label={`Select ${leg.symbol} ${leg.strike} ${leg.optionType}`}
        />
      </span>

      <span className="bc-stock">
        <span className="basket-stock-head">
          <strong className="basket-symbol">{leg.symbol}</strong>
          <span className="basket-rowicons">
            <button type="button" title="Link"><Link2 size={13} /></button>
            <button type="button" title="Duplicate"><Copy size={13} /></button>
            <button type="button" title="Remove leg" onClick={() => onRemoveLeg?.(leg.id)}><Trash2 size={13} /></button>
          </span>
        </span>
        <span className="basket-stock-sub">
          <span
            className={`basket-ltp${liveTick?.dir ? ` flash-${liveTick.dir}` : ''}${usingClose ? ' is-close' : ''}`}
            key={liveTick?.at || 0}
            title={usingClose ? "Day's close — no live price yet" : undefined}
          >{formatLtp(ltp)}</span>
          {changePct != null && Number.isFinite(chg) && (
            <span className={`basket-chg ${chgClass}`}>
              {chg > 0 ? '▲' : chg < 0 ? '▼' : ''} {formatChange(changePct)}%
            </span>
          )}
        </span>
      </span>

      <span className="bc-action">
        <button
          type="button"
          className={`basket-action-pill ${isSell ? 'sell' : 'buy'}`}
          title={`${leg.action} — click to flip`}
          onClick={() => onUpdateLeg?.(leg.id, { action: isSell ? 'BUY' : 'SELL' })}
        >
          {isSell ? 'S' : 'B'}
        </button>
      </span>

      <span className="bc-expiry">
        <ExpiryDropdown
          value={leg.expiry}
          expiries={expiries}
          loading={leg.resolving}
          error={leg.resolveError}
          onChange={(next) => onResolveLeg?.(leg.id, { expiry: next })}
        />
      </span>

      <span className="bc-strike">
        {leg.optionType === 'FUT' ? (
          <span className="basket-fut-dash">—</span>
        ) : (
        <span className="basket-stepper">
          {/* Type freely (local update); commit + re-resolve the contract on
              Enter/blur, only if the value actually changed. Arrows step to the
              ADJACENT real strike in this symbol's ladder (via onStepStrike) —
              not a fixed 50 — and re-resolve immediately; onMouseDown
              preventDefault stops the click from blurring the input (which would
              fire a second resolve back to the old strike and race the first). */}
          <input
            type="number"
            value={strikeInput}
            onChange={(event) => setStrikeInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.target.blur(); } }}
            onBlur={(event) => {
              const next = Math.max(0, Number(event.target.value) || 0);
              if (next && next !== Number(leg.strike)) onResolveLeg?.(leg.id, { strike: next });
              else setStrikeInput(leg.strike ?? ''); // snap back if unchanged/invalid
            }}
          />
          <span className="basket-stepper-arrows">
            <button
              type="button" tabIndex={-1} title="Increase strike"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onStepStrike?.(leg.id, +1)}
            >▲</button>
            <button
              type="button" tabIndex={-1} title="Decrease strike"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onStepStrike?.(leg.id, -1)}
            >▼</button>
          </span>
        </span>
        )}
      </span>

      <span className="bc-cepe">
        {leg.optionType === 'FUT' ? (
          <span className="basket-cepe-pill fut">FUT</span>
        ) : (
          <button
            type="button"
            className={`basket-cepe-pill ${leg.optionType === 'PE' ? 'pe' : 'ce'}`}
            title="Toggle CE/PE"
            onClick={() => onResolveLeg?.(leg.id, { optionType: leg.optionType === 'PE' ? 'CE' : 'PE' })}
          >
            {leg.optionType || 'CE'}
          </button>
        )}
      </span>

      <span className="bc-product">
        <button
          type="button"
          className="basket-product-pill"
          title="Toggle product (CF / MIS)"
          onClick={() => onUpdateLeg?.(leg.id, { product: leg.product === 'MIS' ? 'CF' : 'MIS' })}
        >
          {leg.product || 'CF'}
        </button>
      </span>

      <span className="bc-qty">
        <span className="basket-stepper">
          <input
            type="number"
            min="1"
            value={leg.qty ?? 1}
            onChange={(event) => onUpdateLeg?.(leg.id, { qty: Math.max(1, Number(event.target.value) || 1) })}
          />
          <span className="basket-stepper-arrows">
            <button type="button" tabIndex={-1} title="Increase quantity" onClick={() => onUpdateLeg?.(leg.id, { qty: (Number(leg.qty) || 0) + 1 })}>▲</button>
            <button type="button" tabIndex={-1} title="Decrease quantity" onClick={() => onUpdateLeg?.(leg.id, { qty: Math.max(1, (Number(leg.qty) || 1) - 1) })}>▼</button>
          </span>
        </span>
      </span>

      <span className="bc-price">
        <input
          className={`basket-price-input${isMarket ? ' at-market' : ''}`}
          type="number"
          step="0.05"
          readOnly={isMarket}
          value={isMarket ? formatNum(ltp) : (leg.price ?? '')}
          placeholder="0.00"
          title={isMarket ? 'Market order — executes at live price' : 'Limit price'}
          onChange={(event) => onUpdateLeg?.(leg.id, { price: event.target.value })}
        />
        {needsTrigger && (
          <input
            className="basket-trigger-input"
            type="number"
            step="0.05"
            value={leg.triggerPrice ?? ''}
            placeholder="Trigger"
            title="Trigger price"
            onChange={(event) => onUpdateLeg?.(leg.id, { triggerPrice: event.target.value })}
          />
        )}
        <select
          className="basket-ordertype"
          value={orderType}
          title="Order type"
          onChange={(event) => onUpdateLeg?.(leg.id, { priceType: event.target.value })}
        >
          <option value="MARKET">MARKET</option>
          <option value="LIMIT">LIMIT</option>
          <option value="SL">SL</option>
          <option value="SL-M">SL-M</option>
        </select>
      </span>
    </div>
  );
}

function OrderPreviewModal({ name, legs, margin, charges, placing, result, error, onAnalyse, onEdit, onClose, onConfirm }) {
  const placed = Number(result?.placed || 0);
  const failed = Number(result?.failed || 0);
  return createPortal(
    <div className="order-preview-backdrop" role="presentation">
      <section className="order-preview" role="dialog" aria-modal="true" aria-label="Preview basket order">
        <header className="order-preview-titlebar">
          <div className="order-preview-title">
            <strong>{String(name || 'BASKET').toUpperCase()}</strong>
            <span>({legs.length} / 50 Orders)</span>
          </div>
          <div className="order-preview-window-actions">
            <button type="button" title="Minimise" onClick={onClose}><Minus size={14} /></button>
            <button type="button" title="Close" onClick={onClose}><X size={16} /></button>
          </div>
        </header>

        <div className="order-preview-head">
          <span>Name</span>
          <span>Action/Product</span>
          <span>Quantity</span>
          <span>Order Type</span>
          <span>Price</span>
        </div>

        <div className="order-preview-rows">
          {legs.map((leg) => (
            <div className="order-preview-row" key={leg.id}>
              <span className="op-name">
                <strong>{leg.symbol}</strong>
                <small>{previewSubtitle(leg)}</small>
              </span>
              <span className="op-action">
                <b className={leg.action === 'SELL' ? 'sell' : 'buy'}>{leg.action}</b>
                <em>{leg.product || 'CF'}</em>
              </span>
              <span>{Number(leg.qty || 1)} Lots</span>
              <span>{formatOrderType(leg.priceType)}</span>
              <span>{previewPrice(leg)}</span>
            </div>
          ))}
        </div>

        <div className="order-preview-margin">
          <span>Available Margin <strong>-</strong></span>
          <span>Required Margin <strong>{renderMargin(margin)}</strong></span>
        </div>

        {(error || result) && (
          <div className={`order-preview-result${failed ? ' has-fail' : ''}`}>
            {error || `${placed} placed${failed ? `, ${failed} failed` : ''}`}
          </div>
        )}

        <footer className="order-preview-footer">
          <span>Total Charges <strong>{renderMargin(charges)}</strong></span>
          <div className="order-preview-actions">
            <button className="basket-btn analyse" type="button" onClick={onAnalyse} disabled={placing}>
              <BarChart3 size={15} aria-hidden="true" />
              ANALYSE
            </button>
            <button className="basket-btn save" type="button" onClick={onEdit} disabled={placing}>EDIT</button>
            <button className="basket-btn preview" type="button" onClick={onConfirm} disabled={placing || !legs.length || placed > 0}>
              {placing ? 'PLACING...' : 'CONFIRM ORDER'}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

// Expiry dropdown for a basket leg. Lists the symbol's available expiries
// (from the shared master index) and re-resolves the leg's contract on change.
// The menu is portalled to <body> with fixed positioning so it can't be clipped
// by the basket panel's / rows' overflow:hidden.
// Live FUT/OPT search for the basket. Queries our scrip master (/search-scrips)
// — futures first, then nearest-expiry options — and adds the picked contract as
// a leg. Cash/equity is never returned. The dropdown is portalled to <body> so
// the basket panel's overflow:hidden doesn't clip it.
function BasketSearch({ onAdd }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('all'); // all | fut | opt
  const [rect, setRect] = useState(null);
  const boxRef = useRef(null);
  const menuRef = useRef(null);

  const reposition = () => { if (boxRef.current) setRect(boxRef.current.getBoundingClientRect()); };

  // Debounced search as the user types.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); setOpen(false); return undefined; }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/angel/search-scrips?q=${encodeURIComponent(q)}&limit=100`);
        const body = await res.json().catch(() => ({}));
        setResults(Array.isArray(body.results) ? body.results : []);
        setOpen(true);
        reposition();
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // Anchor the portalled menu; close on outside click / Escape.
  useLayoutEffect(() => { if (open) reposition(); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (boxRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  const filtered = results.filter((r) => (
    tab === 'all' ? true : tab === 'fut' ? r.instrument === 'FUT' : r.instrument === 'OPT'
  ));

  return (
    <div className="basket-search" ref={boxRef}>
      <Search className="basket-search-icon" size={15} aria-hidden="true" />
      <input
        className="basket-search-input"
        type="text"
        placeholder="Search and add stocks, options & futures"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => { if (results.length) { setOpen(true); reposition(); } }}
      />
      {query && (
        <button className="basket-search-clear" type="button" title="Clear"
          onClick={() => { setQuery(''); setResults([]); setOpen(false); }}><X size={13} /></button>
      )}
      {open && rect && createPortal(
        <div
          ref={menuRef}
          className="basket-search-dd"
          style={{ position: 'fixed', top: rect.bottom + 4, left: rect.left, width: rect.width }}
        >
          <div className="basket-search-tabs">
            {[['all', 'All'], ['fut', 'Futures'], ['opt', 'Options']].map(([k, l]) => (
              <button key={k} type="button" className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
          <ul className="basket-search-list">
            {loading && <li className="basket-search-empty">Searching…</li>}
            {!loading && !filtered.length && <li className="basket-search-empty">No FUT/OPT contracts for “{query}”</li>}
            {filtered.map((r) => (
              <li key={r.token} className="basket-search-item" onClick={() => onAdd?.(r)}>
                <span className={`bs-badge ${r.instrument.toLowerCase()}`}>{r.instrument}</span>
                <span className="bs-main">
                  <span className="bs-sym">{r.name}<em>{r.exchange}</em></span>
                  <span className="bs-sub">
                    {formatExpiry(r.expiry)}
                    {r.instrument === 'OPT' && <> · {r.strike} <b className={r.optionType === 'PE' ? 'pe' : 'ce'}>{r.optionType}</b></>}
                  </span>
                </span>
                <button className="bs-add" type="button" title="Add to basket"
                  onClick={(e) => { e.stopPropagation(); onAdd?.(r); }}>+</button>
              </li>
            ))}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}

function ExpiryDropdown({ value, expiries = [], loading, error, onChange }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  // Position the portalled menu under the trigger (fixed coords from its rect).
  const reposition = () => {
    if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
  };
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (event) => {
      if (triggerRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    // Keep the fixed menu anchored to the trigger on scroll/resize instead of
    // closing — the button's focus-scroll on open would otherwise slam it shut.
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  // Sort expiries chronologically so the menu reads in date order.
  const sorted = [...expiries].sort((a, b) => Date.parse(a) - Date.parse(b));

  function pick(expiry) {
    setOpen(false);
    if (expiry !== value) onChange?.(expiry);
  }

  return (
    <div className={`basket-expiry${open ? ' open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`basket-field${error ? ' has-error' : ''}`}
        title={error || 'Change expiry'}
        disabled={loading}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{loading ? '…' : formatExpiry(value)}</span>
        <span className="chev">▼</span>
      </button>
      {open && rect && createPortal(
        <ul
          ref={menuRef}
          className="basket-expiry-menu"
          role="listbox"
          style={{ position: 'fixed', top: rect.bottom + 4, left: rect.left, minWidth: rect.width }}
        >
          {sorted.length === 0 && <li className="basket-expiry-empty">No expiries loaded</li>}
          {sorted.map((expiry) => (
            <li
              key={expiry}
              role="option"
              aria-selected={expiry === value}
              className={`basket-expiry-option${expiry === value ? ' active' : ''}`}
              onClick={() => pick(expiry)}
            >
              {formatExpiry(expiry)}
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}

// Charges breakdown popover (shown on hovering the ⓘ next to Total Charges).
// Mirrors Angel's basket: top-level groups (Angel One Brokerage, External
// Charges, Taxes) are bold with their amount; each group's leaf items are
// indented and muted. Closes with the grand total and the T+1 footnote.
function ChargesPopover({ breakup = [], total = 0 }) {
  return (
    <div className="charges-popover" role="tooltip">
      {breakup.map((group, index) => (
        <div className="charges-group" key={`${group.name}-${index}`}>
          <div className="charges-row charges-row-head">
            <span>{group.name}</span>
            <span>{formatRupee(group.amount)}</span>
          </div>
          {Array.isArray(group.breakup) && group.breakup.map((item, childIndex) => (
            <div className="charges-row charges-row-child" key={`${item.name}-${childIndex}`}>
              <span>{item.name}</span>
              <span>{formatRupee(item.amount)}</span>
            </div>
          ))}
        </div>
      ))}
      <div className="charges-row charges-row-total">
        <span>Total Charges</span>
        <span>{formatRupee(total)}</span>
      </div>
      <p className="charges-note">Charges above are approximate, actual charges will reflect on T+1 day.</p>
    </div>
  );
}

function formatRupee(value) {
  const n = Number(value || 0);
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Margin strip: show a spinner-ish label while computing, the error inline, or
// the formatted rupee figure when ready.
function renderMargin(margin) {
  if (!margin) return '₹0.00';
  if (margin.status === 'loading') return 'Calculating…';
  if (margin.status === 'error') return margin.message ? '—' : '—';
  if (margin.status === 'idle') return '₹0.00';
  return `₹${Number(margin.value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function marginClass(status) {
  if (status === 'loading') return 'is-loading';
  if (status === 'error') return 'is-error';
  return '';
}

function formatLtp(value) {
  if (value == null) return '—';
  const n = Number(value);
  return Number.isFinite(n) && n ? n.toFixed(2) : '—';
}

function formatNum(value) {
  const n = Number(value);
  return Number.isFinite(n) && n ? n.toFixed(2) : '0.00';
}

function formatChange(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.00';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

function formatOrderType(value) {
  const type = String(value || 'MARKET').toUpperCase();
  if (type === 'SL') return 'SL';
  if (type === 'SL-M') return 'SL-M';
  if (type === 'LIMIT') return 'LIMIT';
  return 'MARKET';
}

function previewPrice(leg) {
  const type = formatOrderType(leg.priceType);
  if (type === 'MARKET') return '-';
  if (type === 'SL-M') return `Trig ${formatLtp(leg.triggerPrice)}`;
  if (type === 'SL') return `${formatLtp(leg.price)} / Trig ${formatLtp(leg.triggerPrice)}`;
  return formatLtp(leg.price);
}

function previewSubtitle(leg) {
  if (leg.optionType === 'FUT') return formatExpiry(leg.expiry);
  return `${formatExpiry(leg.expiry)} ${leg.strike} ${leg.optionType || ''}`.trim();
}

function formatExpiry(value) {
  const match = String(value || '').match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!match) return value || '—';
  const month = `${match[2].slice(0, 1)}${match[2].slice(1).toLowerCase()}`;
  return `${match[1]} ${month} ${match[3].slice(2)}`;
}
