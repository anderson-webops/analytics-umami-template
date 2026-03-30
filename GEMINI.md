# Workspace Instructions

## Lockfiles, Commits, Tags, And Releases
- If this repo uses a lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, Bun lockfile, or similar), keep it synchronized with dependency manifest changes before committing or pushing. Do not leave manifest and lockfile drift in the worktree or on `main`.
- Do not leave completed work uncommitted. After each coherent, validated change set, create a commit and push it in the same session.
- Use multiple commits and pushes when that keeps unrelated changes, partial validations, or follow-up fixes clearly separated. Prefer small, logically grouped commits over one mixed commit.
- When a change is a meaningful milestone, create an annotated tag. Good candidates include deployable feature sets, notable dependency or security updates, schema or protocol changes, and other changes that are worth naming for rollback or reference.
- When an update is materially user-facing or operationally significant, create a release tied to the relevant tag. Release notes should summarize scope, validation, rollout notes, and any migration or recovery steps.
- Skip tags and releases for trivial doc-only edits and routine housekeeping unless there is a specific operational reason to publish them.
