import {
  ShopifyClient,
  ShopifyClientError,
  ShopifyAuthenticationError,
  ShopifyRateLimitError,
  ShopifyMutationForbiddenError,
  DEFAULT_SHOPIFY_API_VERSION,
} from './shopify-client';

describe('Shopify GraphQL Client (Read-Only & Error Handling)', () => {
  const shopDomain = 'test-store.myshopify.com';
  const accessToken = 'shpat_test_token_123';

  it('uses centralized API version 2026-07 by default', () => {
    const client = new ShopifyClient({ shopDomain, accessToken });
    expect(client.apiVersion).toBe(DEFAULT_SHOPIFY_API_VERSION);
    expect(client.apiVersion).toBe('2026-07');
    expect(client.readCapability).toBe(true);
    expect(client.mutationCapability).toBe(false);
  });

  it('queries shop identity successfully', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          shop: {
            id: 'gid://shopify/Shop/12345',
            myshopifyDomain: 'test-store.myshopify.com',
            name: 'Test Store',
          },
        },
      }),
    } as any);

    const client = new ShopifyClient({ shopDomain, accessToken, fetchFn: mockFetch });
    const identity = await client.getShopIdentity();

    expect(identity.name).toBe('Test Store');
    expect(identity.myshopifyDomain).toBe('test-store.myshopify.com');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test-store.myshopify.com/admin/api/2026-07/graphql.json',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Shopify-Access-Token': accessToken,
        }),
      }),
    );
  });

  it('handles GraphQL top-level errors in HTTP 200 responses', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errors: [{ message: 'Field "unknownField" does not exist on type "Order"' }],
      }),
    } as any);

    const client = new ShopifyClient({ shopDomain, accessToken, fetchFn: mockFetch });
    await expect(client.executeQuery('query { test }')).rejects.toThrow(ShopifyClientError);
  });

  it('translates HTTP 401 into ShopifyAuthenticationError', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ errors: 'Invalid API key or access token' }),
    } as any);

    const client = new ShopifyClient({ shopDomain, accessToken, fetchFn: mockFetch });
    await expect(client.getShopIdentity()).rejects.toThrow(ShopifyAuthenticationError);
  });

  it('translates HTTP 429 into ShopifyRateLimitError with retry-after', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '5' }),
      json: async () => ({ errors: 'Exceeded 2 calls per second' }),
    } as any);

    const client = new ShopifyClient({ shopDomain, accessToken, fetchFn: mockFetch });
    await expect(client.getShopIdentity()).rejects.toThrow(ShopifyRateLimitError);
  });

  it('translates throttled GraphQL error into ShopifyRateLimitError', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errors: [{ message: 'Throttled: API rate limit exceeded' }],
      }),
    } as any);

    const client = new ShopifyClient({ shopDomain, accessToken, fetchFn: mockFetch });
    await expect(client.getShopIdentity()).rejects.toThrow(ShopifyRateLimitError);
  });

  it('parses extensions.cost throttle status when present', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { shop: { id: '1', myshopifyDomain: shopDomain, name: 'T' } },
        extensions: {
          cost: {
            throttleStatus: {
              maximumAvailable: 1000,
              currentlyAvailable: 950,
              restoreRate: 50,
            },
          },
        },
      }),
    } as any);

    const client = new ShopifyClient({ shopDomain, accessToken, fetchFn: mockFetch });
    const result = await client.executeQuery('query { shop { id } }');
    expect(result.throttleStatus?.currentlyAvailable).toBe(950);
  });

  describe('Capability Switch & Mutation Fence', () => {
    it('blocks GraphQL queries starting with mutation keyword', async () => {
      const client = new ShopifyClient({ shopDomain, accessToken });
      await expect(client.executeQuery('mutation { fulfillmentCreate { id } }')).rejects.toThrow(
        ShopifyMutationForbiddenError,
      );
    });

    it('blocks updateTracking mutation', async () => {
      const client = new ShopifyClient({ shopDomain, accessToken });
      await expect(client.updateTracking()).rejects.toThrow(ShopifyMutationForbiddenError);
    });

    it('blocks createFulfillment mutation', async () => {
      const client = new ShopifyClient({ shopDomain, accessToken });
      await expect(client.createFulfillment()).rejects.toThrow(ShopifyMutationForbiddenError);
    });

    it('blocks adjustInventory mutation', async () => {
      const client = new ShopifyClient({ shopDomain, accessToken });
      await expect(client.adjustInventory()).rejects.toThrow(ShopifyMutationForbiddenError);
    });

    it('blocks cancelOrder and createRefund mutations', async () => {
      const client = new ShopifyClient({ shopDomain, accessToken });
      await expect(client.cancelOrder()).rejects.toThrow(ShopifyMutationForbiddenError);
      await expect(client.createRefund()).rejects.toThrow(ShopifyMutationForbiddenError);
    });
  });
});
