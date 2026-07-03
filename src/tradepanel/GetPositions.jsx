// Get Position: account bar + the selected Angel account's net positions
// (Angel getPosition), with live P&L / LTP from the position book.
import { useState } from 'react';
import AngelAccountBar from './AngelAccountBar';
import { useAngelAccount } from './useAngelAccount';
import './tradepanel.css';

const COLUMNS = [
  { key: 'tradingsymbol', label: 'Symbol' },
  { key: 'exchange', label: 'Exch' },
  { key: 'producttype', label: 'Product' },
  { key: 'netqty', label: 'Net Qty', num: true },
  { key: 'buyavgprice', label: 'Buy Avg', money: true },
  { key: 'sellavgprice', label: 'Sell Avg', money: true },
  { key: 'ltp', label: 'LTP', money: true },
  { key: 'pnl', label: 'P&L', money: true, pnl: true },
];

function money(v) {
  const n = Number(v || 0);
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Angel returns pnl on some payloads; otherwise derive from realised+unrealised.
function pnlOf(row) {
  if (row.pnl != null && row.pnl !== '') return Number(row.pnl);
  return Number(row.realised || 0) + Number(row.unrealised || 0);
}

export default function GetPositions() {
  const acc = useAngelAccount();
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('Select an account, then Get Positions');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!acc.client) {
      setStatus('Select an Angel account first');
      return;
    }
    setLoading(true);
    setStatus('Loading positions...');
    try {
      const res = await fetch('/api/angel/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: acc.client }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`);
      if (body.session?.jwtToken) acc.handleClientSession(0, body.session);
      const positions = body.positions || [];
      setRows(positions);
      setStatus(positions.length ? `${positions.length} positions` : 'No open positions');
    } catch (e) {
      setStatus(e.message || 'Failed to load positions');
    } finally {
      setLoading(false);
    }
  };

  const totalPnl = rows.reduce((sum, r) => sum + pnlOf(r), 0);

  return (
    <div className="trade-panel">
      <AngelAccountBar {...acc} />

      <div className="positions-view">
        <div className="positions-toolbar">
          <button className="load-chain-btn" onClick={load} disabled={loading || !acc.client} type="button">
            {loading ? 'Loading' : 'Get Positions'}
          </button>
          {rows.length > 0 && (
            <span className={`positions-total ${totalPnl >= 0 ? 'up' : 'down'}`}>
              Total P&amp;L: Rs.{money(totalPnl)}
            </span>
          )}
          <span className="positions-status">{status}</span>
        </div>

        <div className="positions-table-wrap">
          <table className="positions-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.key} className={c.num || c.money ? 'num' : ''}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.symboltoken || row.tradingsymbol || i}>
                  {COLUMNS.map((c) => {
                    if (c.pnl) {
                      const p = pnlOf(row);
                      return <td key={c.key} className={`num ${p >= 0 ? 'up' : 'down'}`}>{money(p)}</td>;
                    }
                    const v = row[c.key];
                    return (
                      <td key={c.key} className={c.num || c.money ? 'num' : ''}>
                        {c.money ? money(v) : (v == null || v === '' ? '-' : String(v))}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="positions-empty" colSpan={COLUMNS.length}>No positions to show</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
