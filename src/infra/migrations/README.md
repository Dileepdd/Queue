# Migrations

Run these migrations against PostgreSQL in order before starting producer/worker:

1. `001_reliability_core.sql`
2. `002_client_hmac_auth.sql`
3. `003_bearer_token_hash.sql`

Example:

```sql
\i src/infra/migrations/001_reliability_core.sql
\i src/infra/migrations/002_client_hmac_auth.sql
\i src/infra/migrations/003_bearer_token_hash.sql
```
