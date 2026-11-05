// Single-container entry point (used by the root Dockerfile / Render).
// 1) apply DB migrations  2) optionally seed demo data  3) run API (internal) + website (public) together.
// If either process dies, the container exits so the host restarts it cleanly.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(ROOT, 'api'), WEB_DIR = path.join(ROOT, 'web');

const PORT = process.env.PORT || '3000';      // public port (Render sets this)
const API_PORT = process.env.API_PORT || '4000'; // internal only
const env = { ...process.env, JOBS_INLINE: process.env.JOBS_INLINE ?? 'true', IN_PROCESS_SCHEDULER: process.env.IN_PROCESS_SCHEDULER ?? 'true' };

function runOnce(label, args) {
  console.log(`[start] ${label}…`);
  const r = spawnSync('node', args, { cwd: API_DIR, env, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`[start] ${label} failed`); process.exit(1); }
}
runOnce('migrating database', ['dist/scripts/migrate.js']);
if (process.env.DEMO_PASSWORD) runOnce('loading demo data (skipped if present)', ['dist/scripts/seed.js']);

const procs = [
  spawn('node', ['dist/src/main.js'], { cwd: API_DIR, env: { ...env, PORT: API_PORT, HOST: '127.0.0.1' }, stdio: 'inherit' }),
  spawn('node', ['node_modules/next/dist/bin/next', 'start', '-p', PORT, '-H', '0.0.0.0'], { cwd: WEB_DIR, env, stdio: 'inherit' }),
];
for (const p of procs) p.on('exit', (code) => { console.error(`[start] a process exited (${code}); shutting down`); procs.forEach((x) => x.kill()); process.exit(code || 1); });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { procs.forEach((x) => x.kill(sig)); setTimeout(() => process.exit(0), 5000); });
