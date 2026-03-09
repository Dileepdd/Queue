import { Pool } from 'pg';
import { appConfig } from '../config/env.js';

let pool: Pool | undefined;

export function getDbPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: appConfig.databaseUrl,
      ssl: appConfig.dbSsl
        ? {
            rejectUnauthorized: appConfig.dbSslRejectUnauthorized,
          }
        : undefined,
      max: appConfig.dbPoolMax,
      statement_timeout: appConfig.dbStatementTimeoutMs,
      application_name: appConfig.serviceName,
    });
  }
  return pool;
}

export async function closeDbPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
