// `npm run dev` needs BOTH Vite configs watching at once — content.ts is built
// separately from popup+background (see vite.content.config.ts for why) — and plain
// `vite build --watch` only ever runs one config. This is that missing second half,
// written as a plain script rather than a "concurrently"-style dependency: the project
// deliberately has none beyond Vite/TS itself.
//
// `--no-emptyOutDir` on BOTH watchers matters: the main config's default emptyOutDir
// (needed so a one-shot `npm run build` starts from a clean dist/) would otherwise wipe
// out content.js the moment the main watcher rebuilds on any popup/background edit.
import { spawn } from 'node:child_process';

// Windows has no `npx` executable — only npx.cmd — so spawn() must go through a shell
// there to resolve it; everywhere else a shell is unnecessary overhead.
const spawnOpts = { stdio: 'inherit', shell: process.platform === 'win32' };
const children = [
  spawn('npx', ['vite', 'build', '--watch', '--no-emptyOutDir'], spawnOpts),
  spawn('npx', ['vite', 'build', '--watch', '--no-emptyOutDir', '--config', 'vite.content.config.ts'], spawnOpts)
];

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const child of children) child.on('exit', shutdown);
