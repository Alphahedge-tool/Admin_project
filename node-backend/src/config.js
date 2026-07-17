// Runtime configuration and the fixed Angel SmartAPI constants.
// Values come from the environment (matching the original server's env vars)
// with sane defaults so it runs with zero configuration.
import os from 'node:os';

// REST root for all secured/auth calls.
export const SMARTAPI_BASE = 'https://apiconnect.angelone.in';
// SmartWebSocket V2 endpoint for the live feed.
export const SMART_STREAM_URL = 'wss://smartapisocket.angelone.in/smart-stream';
// Angel's full scrip-master (symbol→token) JSON (~8.8 MB).
export const MASTER_URL =
  'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

// How long the on-disk/in-memory scrip master stays fresh.
export const MASTER_TTL_MS = 24 * 60 * 60 * 1000;
// Short window during which repeated identical quote reads are served from
// cache instead of re-hitting Angel — the main lever against paying the same
// round-trip over and over.
export const QUOTE_CACHE_TTL_MS = 750;
// How long a JWT that passed a getRMS liveness probe is trusted before we
// re-validate. Keeps a 3 s poll from doing a getRMS on every request.
export const SESSION_VALID_TTL_MS = 60 * 1000;

// First non-loopback IPv4 address, or 127.0.0.1. Angel requires an
// X-ClientLocalIP header; it doesn't have to be routable.
function localIPv4() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

const ip = process.env.ANGEL_LOCAL_IP || localIPv4();

export const config = {
  port: Number(process.env.PORT) || 3001,
  masterFile: process.env.ANGEL_MASTER_FILE || 'scrip_master.json',
  indexFile: process.env.ANGEL_INDEX_FILE || 'scrip_index.json',
  localIP: ip,
  publicIP: process.env.ANGEL_PUBLIC_IP || ip,
  macAddress: process.env.ANGEL_MAC_ADDRESS || '',
  feedDebug: process.env.FEED_DEBUG === '1',

  // Angel "Spark" web post-trade P&L (the ROI tracker's data source). This API is
  // separate from SmartAPI and authenticates with the browser session's non-trade
  // access token — a short-lived, sensitive credential, so it comes ONLY from the
  // environment and is never committed to source.
  //
  // The party_code (client id) is NOT hardcoded: it is resolved per request from
  // the Angel broker account the user picks in the ROI tracker (sourced from the
  // SQL broker_config table), so this stays empty. The device id is not secret.
  angelPosttradeToken: process.env.ANGEL_POSTTRADE_TOKEN || '',
  angelPosttradeDeviceId:
    process.env.ANGEL_POSTTRADE_DEVICE_ID || '026eed0d-67dd-586f-b2c5-b94ce137530c',
};
