import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfiguration, forwardRequest, childEnvironments } from './runtime.mjs';

const config = {
  FRONTEND_URL: 'https://mike.example.com',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'public-key',
  SUPABASE_SECRET_KEY: 'private-key',
  R2_ENDPOINT_URL: 'https://account.r2.cloudflarestorage.com',
  R2_BUCKET_NAME: 'mikegc', R2_ACCESS_KEY_ID: 'storage-key',
  R2_SECRET_ACCESS_KEY: 'storage-secret',
  DOWNLOAD_SIGNING_SECRET: 'a'.repeat(64),
  USER_API_KEYS_ENCRYPTION_SECRET: 'b'.repeat(64),
};
export const validSecret = JSON.stringify(config);

test('configuration fixes runtime invariants and keeps optional provider settings', () => {
  const result = readConfiguration(JSON.stringify({ ...config, OPENAI_API_KEY: 'model-key', NODE_ENV: 'development', HOST: '0.0.0.0', PORT: '9000', API_PUBLIC_URL: 'http://wrong', REDIS_URL: '' }));
  assert.equal(result.NODE_ENV, 'production');
  assert.equal(result.HOST, '127.0.0.1');
  assert.equal(result.PORT, '3001');
  assert.equal(result.API_PUBLIC_URL, 'https://mike.example.com/api');
  assert.equal(result.OPENAI_API_KEY, 'model-key');
  assert.equal(result.QUEUE_DRIVER, 'postgres');
  assert.equal(result.WORKERS_MODE, 'thread');
});

test('invalid secrets fail without echoing their contents', () => {
  for (const value of [undefined, '{private-key', 'null', '[]', JSON.stringify({ ...config, SUPABASE_SECRET_KEY: '' }), JSON.stringify({ ...config, OPENAI_API_KEY: 123 })]) {
    assert.throws(() => readConfiguration(value), error => !error.message.includes('private-key'));
  }
});

test('production origin and distinct signing keys are mandatory', () => {
  for (const FRONTEND_URL of ['http://mike.example.com', 'https://mike.example.com/path', 'https://user:pass@mike.example.com', 'https://mike.example.com?x=1']) {
    assert.throws(() => readConfiguration(JSON.stringify({ ...config, FRONTEND_URL })));
  }
  assert.throws(() => readConfiguration(JSON.stringify({ ...config, DOWNLOAD_SIGNING_SECRET: 'short' })));
  assert.throws(() => readConfiguration(JSON.stringify({ ...config, USER_API_KEYS_ENCRYPTION_SECRET: config.DOWNLOAD_SIGNING_SECRET })));
});

test('frontend child receives no backend, storage or provider credentials', () => {
  const { backend, frontend } = childEnvironments(readConfiguration(validSecret), { PATH: '/usr/bin', MIKE_ENV: validSecret, AWS_SECRET_ACCESS_KEY: 'inherited-secret' });
  assert.equal(backend.SUPABASE_SECRET_KEY, 'private-key');
  assert.equal(frontend.API_BASE_URL, 'http://127.0.0.1:3001');
  assert.equal(frontend.PORT, '3000');
  assert.equal(frontend.HOSTNAME, '0.0.0.0');
  for (const key of ['SUPABASE_SECRET_KEY', 'R2_SECRET_ACCESS_KEY', 'MIKE_ENV', 'AWS_SECRET_ACCESS_KEY']) assert.equal(frontend[key], undefined);
});

test('proxy preserves POST data, cookies, Origin and query while replacing spoofed forwarding headers', async () => {
  const request = new Request('https://mike.example.com/api/chat?a=1', {
    method: 'POST', body: 'document content',
    headers: { cookie: '__Host-session=opaque', origin: 'https://untrusted.example', 'x-forwarded-for': 'spoofed', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http', 'cf-connecting-ip': '192.0.2.4', forwarded: 'host=attacker.example' },
  });
  const forwarded = forwardRequest(request, 'https://mike.example.com');
  assert.equal(forwarded.url, 'http://mike.example.com/api/chat?a=1');
  assert.equal(forwarded.headers.get('host'), 'mike.example.com');
  assert.equal(forwarded.headers.get('x-forwarded-host'), 'mike.example.com');
  assert.equal(forwarded.headers.get('x-forwarded-proto'), 'https');
  assert.equal(forwarded.headers.get('x-forwarded-for'), '192.0.2.4');
  assert.equal(forwarded.headers.get('forwarded'), null);
  assert.equal(forwarded.headers.get('origin'), 'https://untrusted.example');
  assert.equal(forwarded.headers.get('cookie'), '__Host-session=opaque');
  assert.equal(await forwarded.text(), 'document content');
});
