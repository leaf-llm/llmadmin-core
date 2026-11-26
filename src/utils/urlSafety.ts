/**
 * Best-effort SSRF guard for admin-triggered provider connectivity tests.
 *
 * Provider base URLs are admin-controlled, but on a public deployment an admin
 * token can still be phished. Block the obvious private/link-local/metadata
 * targets unless the operator explicitly opts in for a local Ollama.
 *
 * This is not a DNS-rebinding-proof egress proxy; for hostile multi-tenant use
 * put the gateway behind a network egress policy as well.
 */
export function assertSafeProviderUrl(
  rawUrl: string,
  label = 'Provider URL'
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must start with http:// or https://`);
  }

  if (
    ['1', 'true', 'yes', 'on'].includes(
      (process.env.ALLOW_PRIVATE_PROVIDER_HOSTS || '').toLowerCase()
    )
  ) {
    return url;
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'metadata.google.internal'
  ) {
    throw new Error(
      `${label} points at a local/metadata host; set ALLOW_PRIVATE_PROVIDER_HOSTS=true only if this is intentional`
    );
  }

  // IPv6 loopback / link-local / unique-local.
  if (
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    throw new Error(`${label} points at a private IPv6 address`);
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    const isPrivate =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
    if (isPrivate) {
      throw new Error(
        `${label} points at a private IPv4 address; set ALLOW_PRIVATE_PROVIDER_HOSTS=true only if this is intentional`
      );
    }
  }

  return url;
}
