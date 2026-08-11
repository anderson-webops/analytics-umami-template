# Health Checks

Use these endpoints for monitoring. They do not require authentication, set
cookies, or redirect. Every response sends `Cache-Control: no-store`.

## Analytics App (Next SSR)
- `GET /healthz` returns `200 {"ok":true}`.
- `HEAD /healthz` returns `200` with no response body.
- `GET /readyz` returns `200 {"ok":true}` when required services are available.
- `HEAD /readyz` returns the same readiness status with no response body.
- Readiness checks Postgres always, Redis when enabled, and ClickHouse when enabled.
- A required dependency failure returns `503 {"ok":false}` without identifying the
  dependency or exposing its error.
- `GET /_dbinfo`
  - internal diagnostics only
  - returns non-secret database metadata plus enabled service flags when allowed
  - returns `403 {"ok":false,"error":"forbidden"}` for public requests without internal access

The public probes never include secrets, database names, host details, process
metrics, environment information, or component diagnostics. Use `/healthz` and
`/readyz` for monitors. Do not use `/`, login pages, or `/_dbinfo`.
