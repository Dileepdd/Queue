import crypto from 'node:crypto';

export function sha256Hex(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function buildCanonicalRequest(input: {
  method: string;
  pathWithQuery: string;
  timestampMs: string;
  nonce: string;
  bodyHash: string;
}): string {
  return [input.method.toUpperCase(), input.pathWithQuery, input.timestampMs, input.nonce, input.bodyHash].join('\n');
}

export function signCanonicalRequest(secret: string, canonicalRequest: string): string {
  return crypto.createHmac('sha256', secret).update(canonicalRequest).digest('hex');
}

export function timingSafeEqualHex(leftHex: string, rightHex: string): boolean {
  if (!/^[a-fA-F0-9]+$/.test(leftHex) || !/^[a-fA-F0-9]+$/.test(rightHex)) {
    return false;
  }

  const left = Buffer.from(leftHex, 'hex');
  const right = Buffer.from(rightHex, 'hex');

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

export function parseTimestampMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }

    // Accept unix seconds or milliseconds.
    return trimmed.length <= 10 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return parsed;
}
