# Maintained Picomatch

The original 4.0.7 archive and its registry integrity are retained in
`UPSTREAM.json`. `scripts/package-picomatch.py` deterministically reproduces the
application and build-tool archives, preserving the original license and all
implementation bytes except the reviewed parser boundary and package identity.

Repeated extglobs containing effective variable-quantity output or alternatives
without a simple prefix-free proof use Picomatch's existing unsafe-expression
literalization policy. Ordinary globbing,
escaped or quoted stars, character classes and existing safe collapsed forms
retain their behavior. The repeated-output guard remains active when
`maxExtglobRecursion: false` disables the separate recursion-depth limit.
Literalization escapes backslashes as well as metacharacters. Alternative
comparisons use the effective case flags. Explicit raw-regex and caller-created
parser states retain their caller-owned trust boundary.

The focused suite exercises bounded malicious cases, parser/state and matcher
entrypoints, option variants, ordinary controls and actual application/build-tool
consumers. The immutable original archive remains a comparison input, never an
installed production dependency.
