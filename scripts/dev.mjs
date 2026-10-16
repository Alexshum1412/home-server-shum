// Development runner: starts the API server in watch mode and the Vite dev server together.
// Usage: npm.cmd run dev   (stop with Ctrl+C)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

const children = [
  ['api', [process.execPath, ['--watch', '--env-file-if-exists=.env', 'server/src/index.ts']]],
  ['web', [process.execPath, [vite]]],
].map(([name, [cmd, args]]) => {
  const child = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `[${name}] ${line}`)
      .join('\n');
  child.stdout.on('data', (c) => console.log(prefix(c)));
  child.stderr.on('data', (c) => console.error(prefix(c)));
  child.on('exit', (code) => {
    console.log(`[${name}] exited with code ${code}`);
    shutdown();
  });
  return child;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  setTimeout(() => process.exit(0), 500);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, shutdown);

console.log('API: http://127.0.0.1:8070   UI (dev): http://127.0.0.1:5173   — Ctrl+C to stop');
