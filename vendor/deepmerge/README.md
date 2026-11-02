# Guarded deepmerge fork

This local package preserves the `deepmerge@4.3.1` API for build-only Rollup and SVGR consumers while rejecting prototype-sensitive keys in both merge inputs. It replaces the unpatched upstream version affected by [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/ghsa-gcqx-w48m-w2h4). The original is MIT-licensed; see `LICENSE`. Keep the focused prototype-poisoning and compatibility regressions, locked install, full and production audits, and build checks green. Replace the fork when a supported upstream fix is available.
