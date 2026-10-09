# Repository Guidelines

Shared Sites policy (`../AGENTS.md` when available) applies. These essentials also apply in standalone checkouts:
- Never SSH, SCP, SFTP, tunnel to, or configure access to production. Do not deploy from this checkout; publishing the template does not activate downstream sites, which are handled by protected server-side automation.
- GitGuardian quota, authentication, network, or service failure is not a commit/push blocker. Review outgoing changes, run another available local secret scan, preserve other hooks, and stop on real secret findings.
- Deliver validated template changes through the owned `origin`; never push them to the Umami `upstream` remote.

## Release Line

- Stay on stable `v4.x` for routine template changes; use `v5` only for an intentional breaking template or runtime change.
- Tag and release validated template states that compatible forks should consume, including changes to runtime, schema, auth, packaging, or deployment behavior. Preserve inherited Umami lineage and document migration or recovery requirements.

## Template-First Downstream Workflow

- This is the owned canonical Umami fork. Reconcile relevant `umami-software/umami` changes here, including shared fixes discovered downstream, and validate this template before compatible sites adopt it.
- Keep production migration safeguards in `scripts/check-db.js`: `DIRECT_DATABASE_URL` must identify the same PostgreSQL cluster, database, and schema as `DATABASE_URL`, and skip flags must fail closed inside the database gate itself.

## Dependency & Lockfile Discipline

- Keep workspace manifests and `pnpm-lock.yaml` aligned. Validate dependency changes with a root `pnpm install --frozen-lockfile` and the shared audit/test gates; do not accept a non-frozen fallback.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
