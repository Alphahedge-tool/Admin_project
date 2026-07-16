// Reusable loading skeletons for the trade-panel's custom-CSS tables and cards.
// These mirror the real markup (a <tbody> of <tr>/<td> for tables, stacked
// cards for the strategy strips) so the layout doesn't jump when data lands.
// Styling lives in tradepanel.css (`.tp-skeleton-*`) and is driven entirely by
// the --ao-* design tokens, so it adapts to light and dark automatically.

// A short repeating set of bar widths so the placeholder reads like real,
// varied content instead of a uniform grid.
const CELL_WIDTHS = ['70%', '52%', '84%', '46%', '64%', '58%', '76%'];

// `<SkeletonRows count columns />` — drop straight into a table <tbody> in place
// of the real rows while the first fetch is in flight.
export function SkeletonRows({ count = 6, columns = 5 }) {
  return (
    <>
      {Array.from({ length: count }).map((_, rowIndex) => (
        <tr className="tp-skeleton-row" key={`tp-skeleton-row-${rowIndex}`}>
          {Array.from({ length: columns }).map((__, colIndex) => (
            <td key={`tp-skeleton-cell-${colIndex}`}>
              <span
                className="tp-skeleton-bar"
                style={{ width: CELL_WIDTHS[(rowIndex + colIndex) % CELL_WIDTHS.length] }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// `<SkeletonCards count />` — placeholder rows for the strategy strips in
// Client Dashboard and Sync Net Positions while their first load runs.
export function SkeletonCards({ count = 4 }) {
  return (
    <div className="tp-skeleton-cards" aria-hidden="true">
      {Array.from({ length: count }).map((_, cardIndex) => (
        <div className="tp-skeleton-card" key={`tp-skeleton-card-${cardIndex}`}>
          <div className="tp-skeleton-card-cell">
            <span className="tp-skeleton-bar" style={{ width: '40%' }} />
            <span className="tp-skeleton-bar sm" style={{ width: '68%' }} />
          </div>
          <div className="tp-skeleton-card-cell">
            <span className="tp-skeleton-bar" style={{ width: '55%' }} />
          </div>
          <div className="tp-skeleton-card-cell metrics">
            <span className="tp-skeleton-bar" style={{ width: '80%' }} />
            <span className="tp-skeleton-bar" style={{ width: '80%' }} />
            <span className="tp-skeleton-bar" style={{ width: '80%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}
