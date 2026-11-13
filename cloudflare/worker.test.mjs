import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';

// Substitute only the platform base class; exercise the actual Worker methods.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }', shortCircuit: true };
  return nextResolve(specifier, context);
} });
globalThis.scheduler = { wait: async () => {} };
const { default: worker, MikeGC } = await import('./worker.mjs');
const template = JSON.parse(await readFile(new URL('./secrets.example.json', import.meta.url)));
const secret = JSON.stringify({ ...template, FRONTEND_URL: 'https://mike.example.com', DOWNLOAD_SIGNING_SECRET: 'a'.repeat(64), USER_API_KEYS_ENCRYPTION_SECRET: 'b'.repeat(64) });

function platform(probe) {
  let starts = 0;
  const requests = [];
  const container = {
    running: false,
    start(options) { starts++; this.running = true; assert.equal(options.enableInternet, true); assert.ok(options.env.MIKE_ENV); },
    async setInactivityTimeout(ms) { assert.equal(ms, 21600000); },
    getTcpPort(port) { assert.equal(port, 3000); return { async fetch(request, init) {
      if (typeof request === 'string') return probe ? probe() : new Response('ok');
      requests.push(request);
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: hello\n\n')); c.close(); } }), { headers: { 'content-type': 'text/event-stream', 'set-cookie': '__Host-session=test; Secure; HttpOnly' } });
    } }; },
  };
  const ctx = { container, blockConcurrencyWhile: fn => fn() };
  return { app: new MikeGC(ctx, { MIKE_ENV: secret }), requests, container, starts: () => starts };
}

test('warm requests do not spend the backend health rate limit, but restarts probe again', async () => {
  let probes = 0;
  const p = platform(() => { probes++; return new Response('ok'); });
  for (let i = 0; i < 20; i++) {
    const response = await p.app.fetch(new Request('https://mike.example.com/'));
    await response.body.cancel();
  }
  assert.equal(probes, 1);
  p.container.running = false;
  await p.app.fetch(new Request('https://mike.example.com/'));
  assert.equal(probes, 2);
});

test('concurrent cold requests start once and preserve streaming responses and cookies', async () => {
  const p = platform();
  const [a,b] = await Promise.all([p.app.fetch(new Request('https://mike.example.com/api/chat', { method: 'POST', body: 'one' })), p.app.fetch(new Request('https://mike.example.com/api/chat', { method: 'POST', body: 'two' }))]);
  assert.equal(p.starts(), 1);
  assert.equal(p.requests.length, 2);
  assert.equal(await p.requests[0].text(), 'one');
  assert.equal(await p.requests[1].text(), 'two');
  assert.equal(a.headers.get('set-cookie'), '__Host-session=test; Secure; HttpOnly');
  assert.equal(await a.text(), 'data: hello\n\n');
  await b.body.cancel();
});

test('failed readiness never submits a POST and a later request can recover', async () => {
  let healthy = false;
  const p = platform(() => new Response('', { status: healthy ? 200 : 503 }));
  await assert.rejects(p.app.fetch(new Request('https://mike.example.com/api/chat', { method: 'POST', body: 'one' })));
  assert.equal(p.requests.length, 0);
  healthy = true;
  await p.app.fetch(new Request('https://mike.example.com/api/chat', { method: 'POST', body: 'two' }));
  assert.equal(p.starts(), 1);
  assert.equal(p.requests.length, 1);
});

test('unconfigured Worker returns a generic 503 without allocating a container', async () => {
  const result = await worker.fetch(new Request('https://mike.example.com/'), { MIKE_ENV: '{private-key' });
  assert.equal(result.status, 503);
  assert.ok(!(await result.text()).includes('private-key'));
});

test('public requests always use the same instance and reject alternate hosts', async () => {
  const names = [];
  const env = { MIKE_ENV: secret, MIKEGC: { getByName(name) { names.push(name); return { fetch: async () => new Response('ok') }; } } };
  assert.equal((await worker.fetch(new Request('https://attacker.example/'), env)).status, 404);
  await worker.fetch(new Request('https://mike.example.com/a'), env);
  await worker.fetch(new Request('https://mike.example.com/b'), env);
  assert.deepEqual(names, ['production', 'production']);
});

test('scheduled health calls keep background workers active without browser traffic', async () => {
  const calls = [];
  await worker.scheduled({}, { MIKE_ENV: secret, MIKEGC: { getByName(name) { calls.push(name); return { fetch: async request => { calls.push(request.url); return new Response('ok'); } }; } } });
  assert.deepEqual(calls, ['production', 'https://mike.example.com/api/health']);
});
