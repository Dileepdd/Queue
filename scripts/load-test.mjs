import process from 'node:process';

function readArg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) {
    return fallback;
  }
  return Number(process.argv[idx + 1]);
}

const requests = readArg('requests', 200);
const concurrency = readArg('concurrency', 20);

const queue = [];
for (let i = 0; i < requests; i += 1) {
  queue.push(i);
}

let ok = 0;
let fail = 0;
const startedAt = Date.now();

async function sendOne(i) {
  const idem = `tenant1:email.send:user123:send:v1-load-${i}-${Date.now()}`;
  const body = {
    job: {
      name: 'email.send',
      metadata: {
        idempotencyKey: idem,
        correlationId: `corr-load-${i}`,
        requestedAt: new Date().toISOString(),
        tenantId: 'tenant1',
        schemaVersion: 1,
        priority: 'default',
        workload: 'io-bound',
      },
      payload: {
        to: 'test@example.com',
        subject: 'Load test',
        body: `payload-${i}`,
      },
    },
  };

  const res = await fetch('http://localhost:3000/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.ok) {
    ok += 1;
  } else {
    fail += 1;
  }
}

async function worker() {
  while (queue.length > 0) {
    const i = queue.shift();
    if (i === undefined) {
      return;
    }
    try {
      await sendOne(i);
    } catch {
      fail += 1;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const elapsedMs = Date.now() - startedAt;
console.log(
  JSON.stringify(
    {
      requests,
      concurrency,
      ok,
      fail,
      elapsedMs,
      rps: Number(((ok + fail) / (elapsedMs / 1000)).toFixed(2)),
    },
    null,
    2,
  ),
);
