# Cloudflare self-hosting

Run MikeGC's existing Next.js and Express applications together in one Linux
container behind a Cloudflare Worker. Keep Supabase for Postgres and Auth and
use a private R2 bucket for documents. The user accepted this service split.

## Approaches

- Separate frontend Worker and backend Container: reuses the existing OpenNext
  dependency, but introduces a separately exposed API and adapter validation.
- Combined Container (selected implementation): preserves Node, LibreOffice,
  localhost API routing and the backend's process-local chat streams.
- D1/Workers rewrite: changes the database/auth and parser architectures;
  outside this deployment task.

The combined container uses one stable Durable Object name and a one-minute
scheduled health request to keep background jobs running without user traffic.
This deliberately incurs continuous container charges. Start at standard-2
(6 GiB), with a maximum of one running instance. This is a starting allocation,
not a measured capacity guarantee. No durable application data belongs on disk.

Only Next.js is publicly proxied. Keep secure cookies, original Origin headers,
streaming responses and the existing /api gateway. Sanitize forwarding headers
at the Worker. Pass backend credentials at runtime through a Worker secret;
give the frontend process only its local API URL and basic runtime settings.

Database initialization and workflow ingestion are explicit release operations,
never public HTTP endpoints or automatic container-start operations. No remote
database changes occur until the target is identified. The Word add-in is a
separate future deployment.

Deliver a draft pull request with deployment instructions, tests and image CI.
Cloudflare account access, a selected Supabase project, origin and provider
credentials are still needed for a live deployment. Local cloning/network and
Docker access are blocked in this session; use the GitHub connector for the PR
and report image/deployment validation honestly.
