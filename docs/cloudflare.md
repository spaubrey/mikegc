# Deploy MikeGC on Cloudflare

This deployment runs Next.js and Express together in one Cloudflare Container,
with Supabase for Postgres/Auth and a private R2 bucket for documents. The
Worker exposes only Next.js; the API listens on container loopback and is
reached through the existing same-origin `/api` gateway. LibreOffice and the
background worker threads remain available. No OpenNext conversion is needed.

This is an initial deployment configuration. Image CI and the production
acceptance checks below must pass before using it for client documents.
The Word add-in is not included in this deployment.

## Accounts and costs

You need a Cloudflare Workers Paid account with Containers and R2 enabled, a
Supabase project, and an AI provider key (or user-supplied provider keys in Mike).
Locally you need Node 22.19+, Git and a running Docker daemon with linux/amd64
build support. Use a dedicated new Supabase project for a fresh installation.

The starting container size is `standard-2` (1 vCPU, 6 GiB memory, 12 GB
ephemeral disk), capped at one running instance. This allocation is not load
tested. Scheduled health requests run every minute to keep background work
alive even with no browser sessions. This is a continuously running deployment,
not a scale-to-zero setup: the Workers plan's base price is only part of the
bill. Review [Container pricing](https://developers.cloudflare.com/containers/platform/pricing/),
R2, Supabase, logging and model usage charges before deploying. Container
filesystem contents are temporary; Supabase and R2 hold durable application data.

## 1. Prepare the checkout and credentials

From the repository root:

```bash
npm ci --prefix frontend
frontend/node_modules/.bin/wrangler login
frontend/node_modules/.bin/wrangler whoami
cp cloudflare/secrets.example.json cloudflare/.env.production.json
chmod 600 cloudflare/.env.production.json
```

Use the Wrangler already locked by `frontend/package-lock.json`. This does not
use `npm run deploy --prefix frontend`, which is the separate OpenNext path.
If your login has multiple accounts, set `CLOUDFLARE_ACCOUNT_ID` to the target
account before running provisioning or deployment commands.

Edit `cloudflare/.env.production.json` locally. It is ignored by Git and excluded
from the image. Supply the Supabase URL, publishable/anon key and service-role
key; R2 S3 endpoint and bucket-scoped read/write access credentials; and at
least one provider API key if users will not supply their own. Do not paste
secrets into GitHub issues or chat.

Generate signing and encryption keys separately:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Set `FRONTEND_URL` to the exact HTTPS origin, for example
`https://mikegc.<your-workers-subdomain>.workers.dev`. Find your Workers
subdomain in Cloudflare's Workers & Pages dashboard. `API_PUBLIC_URL` is derived
as `<FRONTEND_URL>/api`. Optional backend settings from `backend/.env.example`
may be added as JSON string values. This deployment fixes production mode,
Postgres queueing, worker threads, and disabled Sentry/raw prompt logging.
The foreground async/Redis feature flags are disabled; no Redis is required.

Validate without displaying secrets:

```bash
node --input-type=module -e 'import { readFileSync } from "node:fs"; import { readConfiguration } from "./cloudflare/runtime.mjs"; readConfiguration(readFileSync("cloudflare/.env.production.json", "utf8")); console.log("Configuration valid")'
```

The checker validates presence, types, HTTPS and generated key format. It does
not authenticate credentials or verify that the project/bucket exists.

## 2. Set up Supabase and the workflow catalog

Confirm the target project before running SQL. For a **new, empty database**,
run `backend/schema.sql` in that project's SQL editor. It contains the complete
schema and migration ledger. For an existing installation, back up first and
follow the migration procedure in [deployment.md](deployment.md); never apply
the complete fresh schema over an existing database.

In Supabase Auth, configure the Site URL and permitted redirect URLs for the
chosen app origin and authentication flows. Configure production email delivery
for confirmation, password-reset and invitation messages. For any OAuth login,
also configure the provider's Supabase callback URL. See the maintained auth
settings and examples in [deployment.md](deployment.md) and `backend/.env.example`.

After the schema exists **and you have completed R2 setup in step 3**, build the image and run the workflow
ingestion release job once, before accepting traffic:

```bash
docker build --platform linux/amd64 -f cloudflare/Dockerfile -t mikegc-cloudflare:local .
docker run --rm --env-file /dev/null \
  -v "$PWD/cloudflare/.env.production.json:/run/mikegc.json:ro" \
  --entrypoint node mikegc-cloudflare:local --input-type=module -e \
  'import { readFileSync } from "node:fs"; import { spawnSync } from "node:child_process"; import { readConfiguration, childEnvironments } from "/opt/mikegc/runtime.mjs"; const configuration=readConfiguration(readFileSync("/run/mikegc.json","utf8")); const result=spawnSync(process.execPath,["dist/jobs/syncWorkflows.js"],{cwd:"/app",env:childEnvironments(configuration,process.env).backend,stdio:"inherit"}); process.exit(result.status ?? 1)'
```

This job downloads and installs the system workflow catalog and its reference
assets. It writes Supabase and R2; it is intentionally not run on container boot
or through a public HTTP endpoint. Repeat it as a release step when upgrading
workflow catalog versions, after applying pending database migrations.

## 3. Create a private R2 bucket

Create the bucket in Cloudflare R2 (or use Wrangler's `r2 bucket create` command).
Create R2 S3 credentials scoped to that bucket with object read/write access.
Keep public bucket access disabled. The app uses expiring signed URLs.

Set bucket CORS in the R2 dashboard, replacing the origin below:

```json
[
  {
    "AllowedOrigins": ["https://mikegc.<your-workers-subdomain>.workers.dev"],
    "AllowedMethods": ["PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type", "x-amz-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Set `R2_ENDPOINT_URL` to your account's S3 API endpoint, not an `r2.dev` URL or
public custom domain. `R2_PUBLIC_ENDPOINT_URL` can remain unset: the same S3
endpoint is browser reachable for signed uploads. Include every trusted app
origin in CORS when changing hostnames. See [deployment.md](deployment.md#object-storage-cors-for-direct-uploads).

## 4. Deploy the Worker and image

Once accounts, database and workflow ingestion are ready:

```bash
node --test cloudflare/*.test.mjs
frontend/node_modules/.bin/wrangler deploy --config cloudflare/wrangler.json
frontend/node_modules/.bin/wrangler secret put MIKE_ENV --config cloudflare/wrangler.json < cloudflare/.env.production.json
frontend/node_modules/.bin/wrangler containers list
```

The first command deploys the Worker and builds/pushes the image with Docker.
Until `MIKE_ENV` is installed it answers 503 without starting the application;
initial scheduled events also fail until configured. First provisioning may
take several minutes. Never put backend keys in Wrangler `vars`, Docker build
arguments, `NEXT_PUBLIC_*` variables or frontend source.

The Worker routes all traffic to the Durable Object named `production`. Do not
randomize this name or add replicas without revisiting process-local stream
resumption and rate limits. Its scheduled requests keep worker threads alive.
Removing the schedule lets the container stop after six hours without traffic;
background jobs then wait until it starts again. To shut down billing activity,
remove the cron trigger and stop the running container in the dashboard.

If updating `MIKE_ENV` on an existing deployment, let active chats/jobs finish,
upload the replacement secret, then stop/restart the existing Container instance
in the Cloudflare dashboard so it reads new runtime values. Updating a Worker
secret alone does not rewrite an already-running container's environment.
Keep encryption keys stable across updates or stored credentials become unreadable.

## 5. Validate before use

- `/api/health` returns `200` and `{"ok":true}`.
- Sign up, confirm email if enabled, sign in, reload, sign out and reset a password.
  Inspect cookies: Secure, HttpOnly, expected SameSite and `__Host-` prefix.
- Upload both a PDF and DOCX. Verify R2 PUT succeeds, conversion/text extraction
  completes, and previews/downloads work.
- Start a provider-backed chat and confirm incremental streaming. Reconnect to
  a conversation, and confirm it survives a page reload as expected.
- Create a second account and verify it cannot access the first account's
  documents or signed-in APIs. Check that storage buckets remain private.
- Leave the browser closed, verify scheduled health events, then confirm queued
  work finishes. Restart the container and confirm stored documents remain.
- Check logs and resources with representative documents. Increase capacity or
  reduce upload concurrency if memory pressure occurs.

These are real-service acceptance checks; mocked Node unit tests do not prove
Cloudflare startup, Next.js proxy semantics, OAuth redirects or native conversion.
Avoid cache rules that cache authenticated pages or `/api/*` responses.

## Custom domain

For a domain such as `mike.yourfirm.com`, add a custom-domain route to
`cloudflare/wrangler.json`:

```json
"routes": [{ "pattern": "mike.yourfirm.com", "custom_domain": true }]
```

Update `FRONTEND_URL` in the secret, Supabase auth settings, OAuth registrations
and R2 CORS to that exact origin. Redeploy, upload the secret and restart the
container. Other hosts deliberately receive 404. Once the domain works, set
`workers_dev` to `false` and redeploy to remove the default public hostname.

## Updates and rollback

CI builds the image and dry-runs the Worker on pull requests; it does not deploy
or receive production credentials. Deploy manually after checks pass. Retain
the previous Git commit/image and back up Supabase before database upgrades.
Drain active chats before replacing the container: resumable stream buffers
are in process memory. Apply database migrations, run workflow sync, then deploy
the matching application. Redeploy a known-good commit for rollback; do not
delete migration ledger rows or assume a code rollback reverses schema changes.

Cloudflare references: [Containers setup](https://developers.cloudflare.com/containers/get-started/),
[runtime API](https://developers.cloudflare.com/containers/api/durable-object-container/),
[configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#containers),
[runtime secrets](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/).
