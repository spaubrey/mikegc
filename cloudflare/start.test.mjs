import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const moduleUrl = new URL('./start.mjs', import.meta.url).href;

async function scenario(t, failing) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mikegc-supervisor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'stopped');
  const sibling = `require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'ready'))},'yes'); process.on('SIGTERM',()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'stopped');process.exit(0)});setInterval(()=>{},1000);`;
  const failure = `setTimeout(()=>process.exit(7),500);`;
  const commands = [
    { command: process.execPath, args: ['-e', sibling] },
    { command: process.execPath, args: ['-e', failing ? failure : 'setInterval(()=>{},1000)'] },
  ];
  const source = `import { supervise } from ${JSON.stringify(moduleUrl)}; process.exit(await supervise(${JSON.stringify(commands)}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  if (!failing) {
    for (let i = 0; i < 100; i++) {
      try { await readFile(path.join(directory, 'ready')); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    child.kill('SIGTERM');
  }
  const [code] = await closed;
  assert.equal(code, failing ? 1 : 0, errors);
  assert.equal(await readFile(marker, 'utf8'), 'stopped');
}

test('a failed service terminates its sibling and exits nonzero', { timeout: 5000 }, t => scenario(t, true));
test('SIGTERM reaches services and allows a graceful exit', { timeout: 5000 }, t => scenario(t, false));
