# Analytics Database Provisioning

New analytics sites must start from an empty PostgreSQL database that Prisma can manage from the first deploy.

## Required Bootstrap Flow

1. Provision a dedicated PostgreSQL role/user for the site.
2. Provision an empty PostgreSQL database owned by that role/user.
3. Write the runtime env file so `DATABASE_URL` points at that empty database and `APP_SECRET` is set.
4. Deploy the app normally and let `prisma migrate deploy` create the schema.
5. After migrations succeed, create only the required initial data:
   - admin user
   - website row

Use the provisioning script after the first successful migration:

```bash
UMAMI_ADMIN_USERNAME=admin \
UMAMI_ADMIN_PASSWORD='choose-a-strong-password' \
UMAMI_WEBSITE_NAME='Example Site' \
UMAMI_WEBSITE_DOMAIN='example.com' \
pnpm exec tsx scripts/provision-site.ts
```

The script is idempotent:

- if the admin user already exists, it will reuse that user
- if the website row already exists for the same domain, it will leave it in place
- if you need to rotate the existing admin password during provisioning, add `UMAMI_UPDATE_ADMIN_PASSWORD=true`

## Do Not Clone Schema From Another Analytics Database

Do not bootstrap a new analytics site by copying tables from another analytics database.

That creates a database whose schema exists, but whose Prisma migration history does not. The next
`prisma migrate deploy` then fails when it tries to apply the initial migration to tables that already exist.

The correct bootstrap path is:

- empty database
- `prisma migrate deploy`
- targeted post-migration provisioning

## About `_prisma_migrations`

Copying `_prisma_migrations` from another analytics database was only a one-time recovery technique for already-broken
environments. It is not the normal provisioning flow and should not be reused for new sites.

If a database was bootstrapped by copying schema without migration state, the preferred fix is to discard that
database, create a fresh empty one, and rerun the normal bootstrap path above.

## Suggested Database Creation Pattern

Use whatever automation your environment already uses, but the end state should always be:

- one dedicated role/user per analytics site
- one empty database per analytics site
- one runtime env file per analytics site

Example Postgres bootstrap outline:

```sql
CREATE ROLE analytics_example LOGIN PASSWORD 'replace-me';
CREATE DATABASE analytics_example OWNER analytics_example;
```

Then point `DATABASE_URL` at that database:

```env
DATABASE_URL=postgresql://analytics_example:replace-me@db-host:5432/analytics_example
APP_SECRET=replace-with-a-random-secret
```
