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
