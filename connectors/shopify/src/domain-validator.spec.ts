import {
  normalizeAndValidateShopDomain,
  ShopifyDomainValidationError,
} from './domain-validator';

describe('Shopify Domain Validator (SSRF Guard)', () => {
  it('accepts valid canonical myshopify domains', () => {
    expect(normalizeAndValidateShopDomain('store.myshopify.com')).toBe('store.myshopify.com');
    expect(normalizeAndValidateShopDomain('my-shop-123.myshopify.com')).toBe('my-shop-123.myshopify.com');
    expect(normalizeAndValidateShopDomain('quick-brand.myshopify.com')).toBe('quick-brand.myshopify.com');
  });

  it('normalizes uppercase and accidental schemes/slashes safely', () => {
    expect(normalizeAndValidateShopDomain('STORE.myshopify.com')).toBe('store.myshopify.com');
    expect(normalizeAndValidateShopDomain('https://store.myshopify.com')).toBe('store.myshopify.com');
    expect(normalizeAndValidateShopDomain('http://store.myshopify.com/')).toBe('store.myshopify.com');
    expect(normalizeAndValidateShopDomain('https://store.myshopify.com/')).toBe('store.myshopify.com');
    expect(normalizeAndValidateShopDomain('  store.myshopify.com/// ')).toBe('store.myshopify.com');
  });

  describe('Shop domain policy - strict canonical myshopify-only', () => {
    it('accepts canonical store.myshopify.com', () => {
      expect(normalizeAndValidateShopDomain('store.myshopify.com')).toBe('store.myshopify.com');
    });

    it('accepts normalized https://store.myshopify.com/', () => {
      expect(normalizeAndValidateShopDomain('https://store.myshopify.com/')).toBe('store.myshopify.com');
    });

    it('rejects arbitrary example.com', () => {
      expect(() => normalizeAndValidateShopDomain('example.com')).toThrow(ShopifyDomainValidationError);
    });

    it('rejects arbitrary shop.example.com', () => {
      expect(() => normalizeAndValidateShopDomain('shop.example.com')).toThrow(ShopifyDomainValidationError);
    });

    it('rejects spoofed myshopify.com.evil.com', () => {
      expect(() => normalizeAndValidateShopDomain('myshopify.com.evil.com')).toThrow(ShopifyDomainValidationError);
    });

    it('rejects userinfo injection store.myshopify.com@evil.com', () => {
      expect(() => normalizeAndValidateShopDomain('store.myshopify.com@evil.com')).toThrow(ShopifyDomainValidationError);
    });

    it('rejects custom merchant domains without guessing/mapping', () => {
      expect(() => normalizeAndValidateShopDomain('mycustombrand.com')).toThrow(ShopifyDomainValidationError);
      expect(() => normalizeAndValidateShopDomain('store.mycustombrand.co.uk')).toThrow(ShopifyDomainValidationError);
    });
  });

  describe('SSRF Protection - rejects dangerous hostnames and IP addresses', () => {
    const dangerousHosts = [
      'localhost',
      '127.0.0.1',
      '169.254.169.254',
      '10.0.0.1',
      '192.168.1.1',
      '0.0.0.0',
      '::1',
      '[::1]',
      'evil.com',
      'myshopify.com.evil.com',
      'evil-myshopify.com',
      'store.myshopify.com@evil.com',
      'evil.com/store.myshopify.com',
      'store.myshopify.com.attacker.com',
    ];

    dangerousHosts.forEach((host) => {
      it(`rejects dangerous host: ${host}`, () => {
        expect(() => normalizeAndValidateShopDomain(host)).toThrow(ShopifyDomainValidationError);
      });
    });
  });

  describe('URL injection & malformed formats', () => {
    const invalidFormats = [
      'store.myshopify.com:8080',
      'store.myshopify.com/admin/api',
      'store.myshopify.com?foo=bar',
      'store.myshopify.com#fragment',
      'user:pass@store.myshopify.com',
      '-store.myshopify.com',
      'store-.myshopify.com',
      'store..myshopify.com',
      'myshopify.com',
      '.myshopify.com',
      '',
      '   ',
    ];

    invalidFormats.forEach((format) => {
      it(`rejects invalid format: ${format}`, () => {
        expect(() => normalizeAndValidateShopDomain(format)).toThrow(ShopifyDomainValidationError);
      });
    });
  });
});
