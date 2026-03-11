# Render Deployment: Single Server or Two Servers

This guide explains both deployment patterns for this queue system on Render.

- Single server: one Render Web Service runs producer API + worker in one process.
- Two servers: one Render Web Service runs producer API, and one Render Background Worker runs worker runtime.

Both patterns use the same external dependencies:

- Cloud Redis for BullMQ queue state and worker coordination
- Cloud Postgres for idempotency, status, dead-letter, auth data

## How Components Connect

Request flow in production:

1. Client sends HTTP request to producer API.
2. Producer validates/authenticates and enqueues jobs in Redis.
3. Worker consumes jobs from Redis queues.
4. Producer and worker both write/read lifecycle data in Postgres.

Connection model:

- Producer and worker do not call each other directly.
- Redis is the message backbone between producer and worker.
- Postgres is shared persistence for both services.

## Option A: Single Server (One Free Render Service)

Use this for demo/dev when you want to minimize cost.

Render service type:

- Web Service only

Commands:

- Build Command: npm install; npm run build
- Start Command: npm run start:all
- Health Check Path: /health

Behavior:

- API and worker run in one Node process using src/index-all.ts.
- If the web service restarts or sleeps, both API and worker pause.

## Option B: Two Servers (Recommended for Reliability)

Use this for stronger uptime and cleaner scaling.

Render services:

1. Producer API
- Type: Web Service
- Build Command: npm install; npm run build
- Start Command: npm run start:producer
- Health Check Path: /health

2. Worker Runtime
- Type: Background Worker
- Build Command: npm install; npm run build
- Start Command: npm run start:worker

Behavior:

- API and worker are isolated.
- Worker can be scaled/restarted independently from API.

## Environment Variables

Set the same core environment variables on whichever services you run.

Required on producer and worker:

- NODE_ENV=production
- SERVICE_NAME=queue-system
- DATABASE_URL=<your_postgres_connection_string>
- REDIS_URL=<your_redis_connection_string>

Strongly recommended:

- DB_SSL=true
- DB_SSL_REJECT_UNAUTHORIZED=false
- LOG_LEVEL=info
- ADMIN_API_TOKEN=<long_random_secret>
- AUTH_BEARER_ENABLED=true
- AUTH_HMAC_REQUIRED=false

Optional queue tuning:

- QUEUE_CONCURRENCY=10
- QUEUE_ATTEMPTS=5
- QUEUE_BACKOFF_MS=1000
- QUEUE_RATE_LIMIT_MAX=100
- QUEUE_RATE_LIMIT_DURATION_MS=1000

Notes:

- Do not hardcode PORT on Render Web Service. Render injects it.
- Worker service does not need a health check path.

## Render Dashboard Setup Steps

1. Connect your GitHub repo in Render.
2. Create service(s) using Option A or Option B.
3. Add environment variables.
4. Deploy producer first, then worker (for Option B).
5. Call GET /health on the web service.
6. Send a test POST /jobs request and verify worker logs show started/completed.

## Which Option Should You Pick?

- Choose single server when cost is the top priority and occasional pauses are acceptable.
- Choose two servers when queue continuity and operational reliability matter.

## Known Free Tier Limitation

Render free web services can sleep when idle.

Impact:

- Single server mode: API and worker both pause during sleep.
- Two server mode on free web + free worker-equivalent constraints: processing continuity is still limited by free-plan runtime behavior.

For always-on queue guarantees, use paid always-on instances.
