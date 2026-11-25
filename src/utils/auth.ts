/**
 * Small auth helpers shared by the admin API and the gateway API.
 *
 * Tokens are compared by SHA-256 digest with a byte-wise XOR accumulation so
 * the comparison is constant-time with respect to the secret value. Web Crypto
 * is available in Node 18+ and in Worker runtimes, which keeps this module
 * portable for the later serverless work.
 */
export async function safeEqual(
  provided: string,
  expected: string
): Promise<boolean> {
  if (!provided || !expected) return false;
  const webcrypto = (globalThis as any).crypto;
  if (!webcrypto?.subtle) {
    return provided === expected;
  }
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    webcrypto.subtle.digest('SHA-256', encoder.encode(provided)),
    webcrypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

export function parseTokenList(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
}

export function isProduction(): boolean {
  return (process.env.NODE_ENV || '').toLowerCase() === 'production';
}

export function isTruthy(value: string | undefined | null): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function tryParseBearerToken(
  authHeader: string | undefined
): string {
  if (!authHeader) return '';
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return parts[1];
  }
  return '';
}
