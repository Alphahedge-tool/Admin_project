import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_PORT = Number(process.env.PORT || 3001);
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

/**
 * A backend left over from a previous run holds the port, and the next `npm run
 * dev` cannot bind: it dies with a raw EADDRINUSE stack trace and --watch then
 * parks on "waiting for file changes", which reads like a crash rather than a
 * duplicate. It happens often enough - a killed terminal, a crashed reload - that
 * making you hunt the PID every time is not reasonable.
 *
 * So a leftover of OUR OWN is reclaimed. Anything else on the port is left strictly
 * alone and reported: this may be someone's database, and no dev script has any
 * business killing a process it does not recognise.
 */
async function ensurePortFree() {
  if (!(await portInUse(BACKEND_PORT))) return;

  const holders = pidsListeningOn(BACKEND_PORT);
  const ours = holders.filter((pid) => /node-backend[\\/]server\.js/i.test(commandOf(pid)));
  const strangers = holders.filter((pid) => !ours.includes(pid));

  if (!ours.length) {
    console.error(`\nPort ${BACKEND_PORT} is in use by something that is not this backend${holders.length ? ` (pid ${holders.join(', ')})` : ''}.`);
    console.error('Leaving it alone - stop it yourself, or set PORT to use another one.\n');
    process.exit(1);
  }

  console.log(`Port ${BACKEND_PORT} was held by a leftover backend (pid ${ours.join(', ')}) - stopping it.`);
  for (const pid of ours) {
    try {
      process.kill(Number(pid));
    } catch {
      /* already gone */
    }
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(150);
    if (!(await portInUse(BACKEND_PORT))) return;
  }

  console.error(`\nPort ${BACKEND_PORT} is still held after stopping the old backend${strangers.length ? ` (pid ${strangers.join(', ')} is not ours)` : ''}.`);
  console.error(`  Windows:  npx kill-port ${BACKEND_PORT}`);
  console.error(`  macOS/Linux:  lsof -ti:${BACKEND_PORT} | xargs kill\n`);
  process.exit(1);
}

function start(name, command, args) {
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
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

await ensurePortFree();

start('backend', process.execPath, ['--watch', 'node-backend/server.js']);
start('frontend', process.execPath, ['node_modules/vite/bin/vite.js']);
