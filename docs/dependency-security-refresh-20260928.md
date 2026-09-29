# September 28 dependency security correction

The owned template updates both `fast-uri` overrides and the reviewed lockfile.
No migration bytes, ledger checksums, authentication rules or published tags change.
Downstream forks must merge this template correction before their site-specific work.

| Dependency | Previous resolution | Corrected resolution | Evidence |
| --- | --- | --- | --- |
| fast-uri | 3.1.6 | 3.1.7 | [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3), [GHSA-58mr-gqgx-xq4g](https://github.com/advisories/GHSA-58mr-gqgx-xq4g) |
| undici | 7.29.0 | 8.10.2 | [GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) |

The second fast-uri finding originally had no patched-version field in the registry
audit response. Its upstream advisory explicitly identifies 3.1.7 as patched, and
fresh full/production audits of the corrected graph return zero findings. No audit
exclusions, severity-threshold reductions or production dependency edits are used.

`prisma -> @prisma/dev -> @prisma/streams-local -> ajv -> fast-uri` is present in the
production graph. This establishes dependency presence, not public-route exploit
reachability. AJV's declared range accepts 3.1.7. Both the conditional override and
the unconditional override must remain consistent; refreshing the lock alone cannot
correct an explicit vulnerable pin.

Undici is resolved through the development test environment, `jsdom@30.1.0`, whose
declared range is `^8.10.2`. Using 8.10.2 both repairs the advisory and removes the
previous forced downgrade to 7.x. Its Node requirement is compatible with the
repository's pinned Node 24 runtime. No direct application WebSocket usage was
established by the focused dependency review.

These package changes do not patch the separately bundled Undici inside Node itself.
The pinned Node 24.18.1 binary reports bundled Undici 7.29.0. Package-audit success
must not be described as a complete audit of that runtime binary or proof that no
vulnerable function is reachable. Any host runtime transition needs its own reviewed
compatibility and deployment checks.

## Validation and delivery

Run the repository's frozen install, full and production audits, `validate`,
`test:packages`, `test:postgres17-restore`, production build and runtime-artifact
verification. Recheck the audits immediately before release publication, since the
advisory database can change during a long build. The tagged template also requires
its native Linux ARM64 isolated-runtime acceptance job. Preserve those exact source
identities in release notes; private-job bypass is not an ARM64 acceptance result.

The existing PostgreSQL 17 test covers actual dump/restore, retained ledger attempts,
forward migration, idempotency and bundled startup, including 28 rejected constraint
variants. Avasan additionally requires the restored classroom 2FA/privacy browser
workflow and its site-specific finalizer tests. Existing legitimate URI/HTTP controls
and application/workspace tests exercise compatibility. No attack payload or live
service vulnerability reproduction is needed for this dependency correction.

The optional offline OSV wrapper refused to run because it expected scanner 2.5.0
but found 2.6.0. Its guard was preserved. The live repository-native audits and
upstream advisory records are the evidence for the corrected dependency graph.

Protected production-data restoration/migration rehearsals, Personal reverse-split
acceptance, exact retained-runtime recovery and the coordinated Avasan listener
transition remain host gates. Source publication does not activate either site,
clear a quarantine, or authorize rewriting a historical migration or live ledger.
