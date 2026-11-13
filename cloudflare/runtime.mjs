const REQUIRED = [
  'FRONTEND_URL', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY', 'R2_ENDPOINT_URL', 'R2_BUCKET_NAME',
  'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'DOWNLOAD_SIGNING_SECRET',
  'USER_API_KEYS_ENCRYPTION_SECRET',
];

export function readConfiguration(secret) {
  let values;
  try { values = JSON.parse(secret); } catch { throw new Error('MIKE_ENV must be a JSON object'); }
  if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error('MIKE_ENV must be a JSON object');
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== 'string' || value.includes('\0')) throw new Error('MIKE_ENV must contain string environment values');
  }
  for (const name of REQUIRED) {
    if (!values[name]?.trim()) throw new Error(`Missing required setting: ${name}`);
  }
  let origin;
  try { origin = new URL(values.FRONTEND_URL); } catch { throw new Error('Invalid FRONTEND_URL'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('FRONTEND_URL must be an HTTPS origin');
  for (const name of ['SUPABASE_URL', 'R2_ENDPOINT_URL']) {
    let url;
    try { url = new URL(values[name]); } catch { throw new Error(`Invalid ${name}`); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${name} must use HTTPS`);
  }
  for (const name of ['DOWNLOAD_SIGNING_SECRET', 'USER_API_KEYS_ENCRYPTION_SECRET']) {
    if (!/^[a-f0-9]{64}$/i.test(values[name])) throw new Error(`${name} must be generated with openssl rand -hex 32`);
  }
  if (values.DOWNLOAD_SIGNING_SECRET === values.USER_API_KEYS_ENCRYPTION_SECRET) throw new Error('Signing and encryption secrets must differ');
  return {
    ...values,
    FRONTEND_URL: origin.origin,
    API_PUBLIC_URL: `${origin.origin}/api`,
    NODE_ENV: 'production', PORT: '3001', HOST: '127.0.0.1',
    QUEUE_DRIVER: 'postgres', WORKERS_MODE: 'thread', DB_JOBS_ENABLED: 'true',
    ASYNC_DOCUMENT_PROCESSING: 'false', ASYNC_TABULAR_EXTRACTION: 'false',
    SENTRY_DISABLED: 'true', LOG_RAW_LLM_STREAM: 'false', RAW_LLM_STREAM_LOG_DIR: '',
  };
}

export function childEnvironments(configuration, inherited) {
  const common = {
    PATH: inherited.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp', NODE_ENV: 'production', NODE_OPTIONS: '--enable-source-maps',
    SENTRY_DISABLED: 'true',
  };
  return {
    backend: { ...common, ...configuration },
    frontend: {
      ...common, PORT: '3000', HOSTNAME: '0.0.0.0',
      API_BASE_URL: 'http://127.0.0.1:3001',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  };
}

export function forwardRequest(request, publicOrigin) {
  const incoming = new URL(request.url);
  const origin = new URL(publicOrigin);
  const target = new URL(`http://${origin.host}${incoming.pathname}${incoming.search}`);
  const forwarded = new Request(target, request);
  for (const name of [...forwarded.headers.keys()]) {
    if (name === 'forwarded' || name.startsWith('x-forwarded-')) forwarded.headers.delete(name);
  }
  forwarded.headers.set('host', origin.host);
  forwarded.headers.set('x-forwarded-host', origin.host);
  forwarded.headers.set('x-forwarded-proto', 'https');
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) forwarded.headers.set('x-forwarded-for', ip);
  return forwarded;
}
