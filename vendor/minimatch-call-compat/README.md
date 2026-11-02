# Redocly minimatch compatibility

`@redocly/openapi-core@1.34.19` calls its `minimatch` dependency as a function. This local adapter preserves that call shape while using patched `minimatch@11.0.3`. The override is scoped to Redocly because `glob@8` uses the older package's internals and is not compatible with a blanket major override. Replace this adapter when Redocly adopts a maintained matching API. Validate the OpenAPI build and the locked dependency audits before release.
