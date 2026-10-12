# Public share URLs

Public share slugs are bearer credentials. The server generates new slugs; API
callers cannot choose or replace them. A normal share edit retains its current
URL. An authorized owner can explicitly rotate a share by posting its current
`name`, `slug`, and `parameters` to `/api/share/id/{shareId}` with `rotate: true`.
Rotation creates a new random slug and share ID in one transaction, invalidating
the prior URL and share tokens. The owner must distribute the replacement URL
to intended recipients.

This release does not silently rotate existing links. A previously created
caller-selected slug remains usable until its owner explicitly rotates or
deletes that share. A deployment or source release alone does not prove that
such links have been remediated. Inventory and rotation of any weak existing
links require an authorized, privacy-preserving operational review; do not put
live slugs, share tokens, or analytics data in release notes or logs.
