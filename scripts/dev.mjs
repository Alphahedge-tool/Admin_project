import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = new Map();
let shuttingDown = false;

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

start('backend', process.execPath, ['--watch', 'node-backend/server.js']);
start('frontend', process.execPath, ['node_modules/vite/bin/vite.js']);
