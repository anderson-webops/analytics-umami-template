# Workspace Instructions

## Lockfiles, Commits, Tags, And Releases
- Do not leave completed work uncommitted. After each coherent, validated change set, create a commit and push it in the same session.
- Use multiple commits and pushes when that keeps unrelated changes, partial validations, or follow-up fixes clearly separated. Prefer small, logically grouped commits over one mixed commit.
- Keep `pnpm-lock.yaml` synchronized before every commit or push.
- Use lowercase annotated semver tags only. Do not invent ad-hoc labels such as `V1`, `torca-r07`, `pre-lfs-migration-*`, or similar one-off names.
- This repo follows the stable `v3.x` line. Stay on `v3` for routine work; only cut `v4` for an intentional breaking template or runtime change.
- Before creating a new tag, check the latest tag in the active semver line and decide whether the new commit is still the same release milestone. If it is, move that existing tag forward to the new validated commit instead of minting a new version number.
- Keep the GitHub release aligned with that decision: when the commit still belongs to the same milestone, update or recreate the existing release so it points at the moved tag/current commit; only create a brand-new release when the change creates a genuinely new milestone.
- Cut a fresh semver tag and release only when the work crosses a real release boundary, such as a new deployable milestone, a materially different operator/user-facing state, or a version-line change that deserves its own notes and rollback point.
- Create an annotated tag when template state changes in ways forks should intentionally consume, especially runtime/build, schema, tracker, auth, packaging, or deploy behavior.
- Create a GitHub release when that tag is the template version you expect downstream analytics forks to adopt. Release notes should summarize scope, validation, rollout notes, and any migration or recovery steps.
- If the existing tag or release history contains stale drafts, redundant entries, or ad-hoc labels, clean that history up instead of preserving clutter.
- Skip tags and releases for trivial doc-only edits, formatting-only changes, or routine housekeeping unless they change deployment, operations, or a consumer-facing contract.
- Keep inherited upstream lineage unless there is a concrete cleanup reason; new local tags and releases should describe deployable local template states, not ad-hoc sync checkpoints.

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
