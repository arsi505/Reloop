export class ShopifyDomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopifyDomainValidationError';
  }
}

/**
 * Validates and normalizes a Shopify shop domain.
 * Must be a canonical subdomain of myshopify.com.
 * Returns the normalized canonical domain (e.g. 'store.myshopify.com').
 * Throws ShopifyDomainValidationError on invalid or SSRF attempts.
 */
export function normalizeAndValidateShopDomain(rawDomain: string): string {
  if (!rawDomain || typeof rawDomain !== 'string') {
    throw new ShopifyDomainValidationError('Shop domain must be a non-empty string');
  }

  let cleaned = rawDomain.trim();

  // Strip accidental http:// or https:// scheme if present
  if (cleaned.startsWith('https://')) {
    cleaned = cleaned.slice(8);
  } else if (cleaned.startsWith('http://')) {
    cleaned = cleaned.slice(7);
  }

  // Remove trailing slashes
  while (cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1);
  }

  // Reject if any path, query, fragment, port, userinfo, or backslash remain
  if (
    cleaned.includes('/') ||
    cleaned.includes('?') ||
    cleaned.includes('#') ||
    cleaned.includes(':') ||
    cleaned.includes('@') ||
    cleaned.includes('\\')
  ) {
    throw new ShopifyDomainValidationError(
      `Invalid shop domain format: path, query, port, or userinfo not allowed: "${rawDomain}"`,
    );
  }

  cleaned = cleaned.toLowerCase();

  // Must match strictly <subdomain>.myshopify.com
  // Subdomain: alphanumeric and hyphens, 1-63 characters, cannot start or end with hyphen
  const shopifyRegex = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;

  if (!shopifyRegex.test(cleaned)) {
    throw new ShopifyDomainValidationError(
      `Shop domain "${rawDomain}" is not a valid canonical .myshopify.com domain`,
    );
  }

  return cleaned;
}
