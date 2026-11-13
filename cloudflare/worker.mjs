import { DurableObject } from 'cloudflare:workers';
import { readConfiguration, forwardRequest } from './runtime.mjs';

const IDLE_MS = 6 * 60 * 60 * 1000;

export class MikeGC extends DurableObject {
  starting;
  initialized = false;

  constructor(ctx, env) {
    super(ctx, env);
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(IDLE_MS));
    }
  }

  async ready() {
    const configuration = readConfiguration(this.env.MIKE_ENV);
    const container = this.ctx.container;
    if (!container.running) {
      container.start({ enableInternet: true, env: { MIKE_ENV: JSON.stringify(configuration) } });
    }
    await container.setInactivityTimeout(IDLE_MS);
    const port = container.getTcpPort(3000);
    // Probe a safe endpoint only. Never retry or pre-consume an incoming body.
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await port.fetch(`http://${new URL(configuration.FRONTEND_URL).host}/api/health`, {
          headers: { 'x-forwarded-proto': 'https' },
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        if (response.ok) { this.initialized = true; return; }
      } catch { /* Next.js or the API may still be starting. */ }
      await scheduler.wait(500);
    }
    throw new Error('MikeGC container readiness timed out');
  }

  async fetch(request) {
    if (!this.ctx.container.running) this.initialized = false;
    if (!this.initialized) {
      this.starting ??= this.ready().finally(() => { this.starting = undefined; });
      await this.starting;
    }
    const configuration = readConfiguration(this.env.MIKE_ENV);
    try {
      return await this.ctx.container.getTcpPort(3000).fetch(forwardRequest(request, configuration.FRONTEND_URL));
    } catch (error) {
      this.initialized = false;
      throw error;
    }
  }
}

function unavailable() {
  return new Response('MikeGC is temporarily unavailable. Check deployment configuration and container logs.', {
    status: 503, headers: { 'retry-after': '10', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    try {
      const configuration = readConfiguration(env.MIKE_ENV);
      if (new URL(request.url).origin !== configuration.FRONTEND_URL) return new Response('Not found', { status: 404 });
      return await env.MIKEGC.getByName('production').fetch(request);
    } catch {
      // Never log the secret JSON or a request body in the edge runtime.
      console.error('[cloudflare] MikeGC request failed; inspect container logs');
      return unavailable();
    }
  },
  async scheduled(_event, env) {
    const configuration = readConfiguration(env.MIKE_ENV);
    const response = await env.MIKEGC.getByName('production').fetch(new Request(`${configuration.FRONTEND_URL}/api/health`));
    await response.body?.cancel();
    if (!response.ok) throw new Error('MikeGC scheduled health check failed');
  },
};
