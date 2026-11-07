# Redocly minimatch compatibility

`@redocly/openapi-core@1.34.24` calls its `minimatch` dependency as a function. This local adapter preserves that call shape while using patched `minimatch@11.0.5`. The override is scoped to Redocly because unrelated consumers may depend on older package internals and are not covered by this adapter. Replace it when Redocly adopts a maintained matching API. Validate the real consumer, OpenAPI build and locked dependency audits before release.
