# Cloudflare Implementation Plan

> Implement in this session, with focused verification before publishing the draft PR.

**Goal:** Provide a reviewable Cloudflare deployment for MikeGC.

**Architecture:** One Worker routes to one combined Next.js/Express Container.
Supabase owns database/auth; R2 owns uploaded documents. Scheduled health calls
keep the application's background workers alive between browser sessions.

**Tech Stack:** Existing Node 22 images and lockfiles, Cloudflare Containers,
Durable Objects, Wrangler already locked in frontend/package-lock.json.

**Spec:** ../specs/2026-11-12-cloudflare-design.md

## Global constraints

- No application or database behavior changes; no credentials in Git.
- Build from repository root; backend keeps LibreOffice and prlimit.
- Use one stable instance and streaming proxies without retrying mutations.
- Report blocked image builds and account setup separately from passing tests.

## Review focus

- Secret errors must not echo credentials; malformed JSON must fail closed.
- Caller-supplied forwarding headers must not control the application's origin.
- Cold startup must not replay POST bodies; failed readiness must be retryable.
- A failed child process must stop its sibling; SIGTERM must reach both.
- Background jobs must continue without user requests; cron keeps the instance warm.

## Task 1: Container runtime and Worker

Create cloudflare/runtime.mjs, worker.mjs, start.mjs, Dockerfile and
wrangler.json. Write Node tests first for configuration, routing, startup and
process supervision. Run node --test cloudflare/*.test.mjs red then green.

## Task 2: Deployment guide and CI

Create docs/cloudflare.md and a secret template. Add root-context image build
and Worker dry-run to .github/workflows/cloudflare.yml. Document schema setup,
workflow sync, R2 CORS, runtime secrets, costs, custom domain, validation and
rollback. Do not automatically run migrations or deploy from a PR.

## Task 3: Verification and draft PR

Run Node tests, syntax checks and git diff --check. Inspect all added files.
Publish a dedicated feature branch through GitHub, open a draft PR and inspect
checks. Leave live deployment pending account/project identification.
