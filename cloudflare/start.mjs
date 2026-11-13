import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readConfiguration, childEnvironments } from './runtime.mjs';

// Fail the whole container if either application exits. Signal process groups
// so Next's children receive the same graceful shutdown as the backend.
export function supervise(commands) {
  return new Promise(resolve => {
    let stopping = false;
    let result = 1;
    let remaining = commands.length;
    let deadline;
    const children = commands.map(({ command, args, cwd, env }) => spawn(command, args, {
      cwd, env, detached: true, stdio: 'inherit',
    }));
    const signal = (child, value) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      try { process.kill(-child.pid, value); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    const stop = code => {
      if (stopping) return;
      stopping = true;
      result = code;
      for (const child of children) signal(child, 'SIGTERM');
      deadline = setTimeout(() => {
        for (const child of children) signal(child, 'SIGKILL');
      }, 20_000);
      deadline.unref();
    };
    const shutdown = () => stop(0);
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    for (const child of children) {
      child.on('error', () => { console.error('[cloudflare] Application process failed to start'); stop(1); });
      child.on('close', () => {
        if (!stopping) { console.error('[cloudflare] Application process exited unexpectedly'); stop(1); }
        if (--remaining === 0) {
          clearTimeout(deadline);
          process.off('SIGTERM', shutdown);
          process.off('SIGINT', shutdown);
          resolve(result);
        }
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const configuration = readConfiguration(process.env.MIKE_ENV);
    const env = childEnvironments(configuration, process.env);
    // The secret is forwarded only to the backend process, never to Next.js.
    delete process.env.MIKE_ENV;
    process.exitCode = await supervise([
      { command: process.execPath, args: ['--enable-source-maps', 'dist/index.js'], cwd: '/app', env: env.backend },
      { command: process.execPath, args: ['node_modules/next/dist/bin/next', 'start', '-H', '0.0.0.0', '-p', '3000'], cwd: '/web/frontend', env: env.frontend },
    ]);
  } catch {
    console.error('[cloudflare] Invalid container configuration');
    process.exitCode = 1;
  }
}
