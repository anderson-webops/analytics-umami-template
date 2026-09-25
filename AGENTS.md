# Repository Guidelines

## Agent Delivery Workflow
- Do not leave completed work uncommitted. After each coherent, validated change set, create a commit and push it in the same session.
- Use multiple commits and pushes when that keeps unrelated changes, partial validations, or follow-up fixes clearly separated. Prefer small, logically grouped commits over one mixed commit.
- Keep `pnpm-lock.yaml` synchronized before every commit or push.
- Use lowercase annotated semver tags only. Do not invent ad-hoc labels such as `V1`, `torca-r07`, `pre-lfs-migration-*`, or similar one-off names.
- This repo follows the stable `v4.x` line. Stay on `v4` for routine work; only cut `v5` for an intentional breaking template or runtime change.
- Before creating a new tag, check the latest tag in the active semver line and choose the smallest appropriate version increment. Published tags are immutable; never move or force-update one. If a tagged candidate fails before release publication, preserve that tag without a release and use the next patch version for the corrected candidate.
- Publish the matching GitHub release only after the exact tagged source passes its release gates. Never retarget an existing release by moving its tag.
- Cut a fresh semver tag and release only when the work crosses a real release boundary, such as a new deployable milestone, a materially different operator/user-facing state, or a version-line change that deserves its own notes and rollback point.
- Create an annotated tag when template state changes in ways forks should intentionally consume, especially runtime/build, schema, tracker, auth, packaging, or deploy behavior.
- Create a GitHub release when that tag is the template version you expect downstream analytics forks to adopt. Release notes should summarize scope, validation, rollout notes, and any migration or recovery steps.
- If the existing tag or release history contains stale drafts, redundant entries, or ad-hoc labels, clean that history up instead of preserving clutter.
- Skip tags and releases for trivial doc-only edits, formatting-only changes, or routine housekeeping unless they change deployment, operations, or a consumer-facing contract.
- Keep inherited upstream lineage unless there is a concrete cleanup reason; new local tags and releases should describe deployable local template states, not ad-hoc sync checkpoints.

## Template-First Downstream Workflow

- This repository is the owned canonical source for generally applicable changes to its Umami-based analytics forks. Reconcile relevant `umami-software/umami` updates here first, implement and validate the shared change once, and deliver the coherent template state before changing downstream sites.
- Merge the reviewed template change into every structurally compatible downstream fork. Preserve genuine site-specific identity, branding, provisioning, secrets boundaries, and runtime configuration while resolving conflicts; apply site-specific edits only afterward and separately where practical.
- Do not independently copy a shared fix into one downstream fork and leave the template or peer forks behind. If an urgent downstream discovery is generally applicable, backport it here first and then propagate the resulting template change.
- If a downstream repository intentionally follows a different major line, structure, or upstream history, document why this template is inapplicable instead of forcing unrelated histories together.
- Treat a downstream's successfully applied Prisma migration bytes as site-specific state. Merge the shared contract mechanism first, but preserve a downstream-specific historical migration and `prisma/migration-ledger-contract.json` when its production ledger differs from the template. Add desired SQL effects through a new forward migration; never normalize source by rewriting the database ledger.
- Route every supported migration command through `scripts/check-db.js`. When `DIRECT_DATABASE_URL` is configured, prove it identifies the same PostgreSQL cluster, database, and schema as `DATABASE_URL` before any migration; production skip flags must fail closed inside the database gate itself.

## Dependency & Lockfile Discipline

- Treat the repo-root `pnpm install --frozen-lockfile` path as the source of truth for deploy readiness.
- Any time `package.json`, any workspace `package.json`, dependency ranges, `pnpm-lock.yaml`, or dependency update tooling changes, verify lockfile parity from the repo root before committing.
- Do not rely on a non-frozen `pnpm install` fallback as success. A change is not deploy-ready unless the frozen root install succeeds.

Required production/dev dependency update flow before every dependency commit:
1. Check production and development dependency freshness from the repository root with `pnpm outdated --recursive` or the repo's documented equivalent.
2. Review both `dependencies` and `devDependencies` in the root and every workspace package; do not limit updates to production-only packages.
3. Apply needed updates with the narrowest command that updates the relevant manifest and lockfile together, such as `pnpm up <package>@<version>` or `pnpm up -D <package>@<version>`.
4. If the update is only a lockfile/security refresh, regenerate from the root with `pnpm install --lockfile-only --ignore-scripts`.
5. Run `pnpm audit` from the repository root and resolve remaining production or dev advisories before committing unless a documented upstream limitation prevents it.

Required dependency verification before every commit/push:
1. Run `pnpm install --frozen-lockfile` from the repository root.
2. Run `pnpm run lint`.
3. Run `pnpm run typecheck`.
4. Run `pnpm run build`.
5. If API or back-end behavior changed, run the repo's API/back-end test command.

If the frozen install fails because manifests and `pnpm-lock.yaml` are out of sync:
1. Run `pnpm install --lockfile-only --ignore-scripts` from the repository root.
2. Re-run `pnpm install --frozen-lockfile` from the repository root.
3. Commit the resulting `pnpm-lock.yaml` change with the related dependency/package change.

Never commit or push dependency/package changes if the frozen root install fails.

## Direct Delivery and Pull Requests

- After a coherent change set passes the repository's required checks, default to committing it and pushing it directly to the repository's default branch. Do not open a pull request unless the user explicitly asks for one, branch protection requires it, or an external-contribution policy makes direct integration inappropriate.
- For a release-worthy application change, update the project version as required, create an annotated tag, and publish or update the corresponding GitHub release in the same work session. Keep documentation-only, formatting-only, and other non-deployable housekeeping changes as committed and pushed source changes without inventing an application release.
- Never force-push a shared branch or move an existing published tag unless the user explicitly authorizes that exact history rewrite.
- If automation or repository policy creates a pull request, review it, wait for required checks, merge it when safe, and remove the merged branch before wrapping up. Do not leave redundant pull requests or branches open.
- Treat commit, push, tag, and GitHub release publication as source delivery only. Do not claim or perform production deployment unless it was separately authorized and verified.
