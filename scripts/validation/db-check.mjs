import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

const current = await client.query(`
  select queue, job_id, status, updated_at
  from job_status_current
  order by updated_at desc
  limit 20
`);

const idem = await client.query(`
  select tenant_id, idempotency_key, status, locked_until, updated_at
  from idempotency_records
  order by updated_at desc
  limit 20
`);

const dlq = await client.query(`
  select id, queue, job_id, job_name, reason, reprocessed, created_at
  from dead_letter_records
  order by created_at desc
  limit 20
`);

console.log('job_status_current:', current.rows);
console.log('idempotency_records:', idem.rows);
console.log('dead_letter_records:', dlq.rows);

await client.end();
