# Disposable development seed data

`pnpm db:seed` is only for a dedicated, disposable PostgreSQL database on the same machine. Never point it at production, a shared development database, a production copy, or a forwarded connection. It does not run migrations or create an admin user.

Create a fresh local database and apply the normal schema migrations. In that database only, create this positive marker in the schema selected by `DATABASE_URL` (normally `public`):

```sql
CREATE TABLE public.umami_seed_disposable_guard (marker text PRIMARY KEY);
INSERT INTO public.umami_seed_disposable_guard (marker)
VALUES ('umami-disposable-seed-v1');
```

The marker is deliberately not part of application migrations. Do not copy it into an environment that is not disposable. The command requires `NODE_ENV=development` or `test`, an explicit opt-in, a loopback PostgreSQL URL with no connection-changing query options, and exactly one marker row in the active schema. A missing or ambiguous marker fails closed before any data changes. Generated data is limited to 90 days.

```sh
NODE_ENV=development pnpm db:seed --allow-disposable-seed
NODE_ENV=development pnpm db:seed --allow-disposable-seed --clear --confirm-clear
```

The first run creates two websites with stable seed-owned IDs. A repeat run without `--clear` refuses to overwrite them. Clearing requires both flags and deletes only those IDs after verifying their original name, domain, administrator ownership, and non-team state. Older demo websites created with random IDs are never deleted by name; review and remove them manually in a disposable database if desired. Do not copy the marker table or seeded database to production.
