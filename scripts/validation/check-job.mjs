import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const jobId = process.argv[2];
const idempotencyKey = process.argv[3];

if (!jobId || !idempotencyKey) {
  console.error('Usage: node scripts/validation/check-job.mjs <jobId> <idempotencyKey>');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

const current = await client.query(
  `
    select queue, job_id, status, updated_at
    from job_status_current
    where job_id = $1
    order by updated_at desc
    limit 1
  `,
  [jobId],
);

const events = await client.query(
  `
    select status, created_at
    from job_status_events
    where job_id = $1
    order by created_at asc
  `,
  [jobId],
);

const idem = await client.query(
  `
    select status, error_code, error_message, locked_until, updated_at
    from idempotency_records
    where idempotency_key = $1
    limit 1
  `,
  [idempotencyKey],
);

console.log('current:', JSON.stringify(current.rows, null, 2));
console.log('events:', JSON.stringify(events.rows, null, 2));
console.log('idempotency:', JSON.stringify(idem.rows, null, 2));

await client.end();
