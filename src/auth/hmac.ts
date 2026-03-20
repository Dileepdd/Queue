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
  const isHex = (str: string) => /^[a-fA-F0-9]+$/.test(str);
  const left = Buffer.from(leftHex, 'hex');
  const right = Buffer.from(rightHex, 'hex');
  return isHex(leftHex) && isHex(rightHex) && left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function parseTimestampMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // Helper: is numeric string
  const isNumeric = (str: string) => /^\d+$/.test(str);

  if (isNumeric(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return undefined;
    // Accept unix seconds or milliseconds.
    return trimmed.length <= 10 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
}
