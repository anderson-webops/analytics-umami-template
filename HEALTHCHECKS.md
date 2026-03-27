# Health Checks

Use these endpoints for monitoring. They do not require auth and do not redirect.

## Analytics App (Next SSR)
- `GET /healthz`
  - returns `200 {"ok":true}`
- `GET /readyz`
  - returns `200 {"ready":true,"components":{...}}` when required services are available
  - checks Postgres always, Redis when enabled, and ClickHouse when enabled
  - returns `503 {"ready":false,...}` when a required enabled dependency is unavailable
- `GET /_dbinfo`
  - internal diagnostics only
  - returns non-secret database metadata plus enabled service flags when allowed
  - returns `403 {"ok":false,"error":"forbidden"}` for public requests without internal access

Use `/healthz` and `/readyz` for monitors. Do not use `/`, login pages, or `/_dbinfo`.
