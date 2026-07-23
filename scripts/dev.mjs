import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BACKEND_PORT = Number(process.env.PORT || 3001);
const PORT_SCAN_RANGE = 20;
const children = new Map();
let shuttingDown = false;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Is something already listening there? Binding the same way the backend does -
// no host, so the OS picks the same dual-stack wildcard address it would.
function portInUse(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (error) => resolve(error.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port);
  });
}

function pidsListeningOn(port) {
  try {
    if (process.platform === 'win32') {
      return [...new Set(
        execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
          .split('\n')
          .filter((line) => line.includes('LISTENING') && new RegExp(`[:.]${port}\\s`).test(line))
          .map((line) => line.trim().split(/\s+/).pop())
          .filter((pid) => pid && pid !== '0'),
      )];
    }
    return execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .split('\n').map((pid) => pid.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function commandOf(pid) {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell', [
        '-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ], { encoding: 'utf8' }).trim();
    }
    return execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// The first free port at or above `from`. Used only after the preferred one has
// turned out to be someone else's, so the scan starts one above it.
async function findFreePort(from) {
  for (let port = from; port < from + PORT_SCAN_RANGE; port += 1) {
    if (!(await portInUse(port))) return port;
  }
  return 0;
}

/**
 * A backend left over from a previous run holds the port, and the next `npm run
 * dev` cannot bind: it dies with a raw EADDRINUSE stack trace and --watch then
 * parks on "waiting for file changes", which reads like a crash rather than a
 * duplicate. It happens often enough - a killed terminal, a crashed reload - that
 * making you hunt the PID every time is not reasonable.
 *
 * So a leftover of OUR OWN is reclaimed. Anything else on the port is left strictly
 * alone - it may be someone's database, and no dev script has any business killing
 * a process it does not recognise - and we step aside onto the next free port
 * instead of refusing to start. The port we settle on is handed to both children,
 * so the Vite proxy follows the backend wherever it lands.
 */
async function resolveBackendPort() {
  if (!(await portInUse(DEFAULT_BACKEND_PORT))) return DEFAULT_BACKEND_PORT;

  const holders = pidsListeningOn(DEFAULT_BACKEND_PORT);
  const ours = holders.filter((pid) => /node-backend[\\/]server\.js/i.test(commandOf(pid)));

  if (ours.length) {
    console.log(`Port ${DEFAULT_BACKEND_PORT} was held by a leftover backend (pid ${ours.join(', ')}) - stopping it.`);
    for (const pid of ours) {
      try {
        process.kill(Number(pid));
      } catch {
        /* already gone */
      }
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(150);
      if (!(await portInUse(DEFAULT_BACKEND_PORT))) return DEFAULT_BACKEND_PORT;
    }
  }

  const fallback = await findFreePort(DEFAULT_BACKEND_PORT + 1);
  if (!fallback) {
    console.error(`\nPort ${DEFAULT_BACKEND_PORT} is taken and nothing is free up to ${DEFAULT_BACKEND_PORT + PORT_SCAN_RANGE - 1}.`);
    console.error(`  Windows:  npx kill-port ${DEFAULT_BACKEND_PORT}`);
    console.error(`  macOS/Linux:  lsof -ti:${DEFAULT_BACKEND_PORT} | xargs kill\n`);
    process.exit(1);
  }

  const holder = holders.length ? ` (pid ${holders.join(', ')})` : '';
  console.log(`\nPort ${DEFAULT_BACKEND_PORT} is in use by something that is not this backend${holder} - leaving it alone.`);
  console.log(`Starting the backend on ${fallback} instead; the Vite proxy will follow.`);
  // Kite's redirect URL is registered in the developer console against the default
  // port, so the browser half of the Zerodha login still expects that one.
  console.log(`Zerodha's browser login popup will not come back until ${DEFAULT_BACKEND_PORT} is free again.\n`);
  return fallback;
}

function start(name, command, args, env = process.env) {
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    env,
  });

  children.set(name, child);

  child.on('exit', (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;
    shuttingDown = true;
    for (const other of children.values()) {
      other.kill('SIGTERM');
    }
    process.exit(code ?? (signal ? 1 : 0));
  });

  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) {
    child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 250).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const backendPort = await resolveBackendPort();

// PORT is what the backend's config reads. VITE_BACKEND_PORT is the same number
// for the frontend: vite.config.js points its /api/angel, /api/kotak and
// /api/zerodha proxies at it, and the VITE_ prefix also carries it into
// import.meta.env so browser code can see where the backend ended up. Both
// children get both, so the two halves cannot disagree.
const childEnv = {
  ...process.env,
  PORT: String(backendPort),
  VITE_BACKEND_PORT: String(backendPort),
};

start('backend', process.execPath, ['--watch', 'node-backend/server.js'], childEnv);
start('frontend', process.execPath, ['node_modules/vite/bin/vite.js'], childEnv);
