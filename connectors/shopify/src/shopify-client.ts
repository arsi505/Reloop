import { normalizeAndValidateShopDomain } from './domain-validator';

export const DEFAULT_SHOPIFY_API_VERSION = '2026-07';

export class ShopifyClientError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly errors?: unknown[];

  constructor(message: string, options?: { status?: number; code?: string; errors?: unknown[] }) {
    super(message);
    this.name = 'ShopifyClientError';
    this.status = options?.status;
    this.code = options?.code;
    this.errors = options?.errors;
  }
}

export class ShopifyRateLimitError extends ShopifyClientError {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds = 2) {
    super(message, { status: 429, code: 'THROTTLED' });
    this.name = 'ShopifyRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ShopifyAuthenticationError extends ShopifyClientError {
  constructor(message: string) {
    super(message, { status: 401, code: 'UNAUTHENTICATED' });
    this.name = 'ShopifyAuthenticationError';
  }
}

export class ShopifyMutationForbiddenError extends ShopifyClientError {
  constructor(actionName: string) {
    super(
      `Shopify mutation "${actionName}" is forbidden: Day 15 connector is strictly READ-ONLY.`,
      { status: 403, code: 'MUTATION_DISABLED' },
    );
    this.name = 'ShopifyMutationForbiddenError';
  }
}

export interface ShopifyThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface ShopifyShopIdentity {
  id: string;
  myshopifyDomain: string;
  name: string;
}

export interface ShopifyLineItemNode {
  id: string;
  sku: string | null;
  quantity: number;
  title: string;
}

export interface ShopifyTrackingInfo {
  number: string | null;
  company: string | null;
  url: string | null;
}

export interface ShopifyFulfillmentNode {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  trackingInfo: ShopifyTrackingInfo[];
}

export interface ShopifyOrderNode {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  displayFulfillmentStatus: string | null;
  displayFinancialStatus: string | null;
  cancelledAt: string | null;
  totalPriceSet?: {
    shopMoney?: {
      amount: string;
      currencyCode: string;
    };
  };
  lineItems?: {
    edges: Array<{ node: ShopifyLineItemNode }>;
  };
  fulfillments?: ShopifyFulfillmentNode[];
}

export interface ShopifyOrdersPage {
  orders: ShopifyOrderNode[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    endCursor: string | null;
    startCursor: string | null;
  };
  throttleStatus?: ShopifyThrottleStatus;
}

export interface ShopifyClientConfig {
  shopDomain: string;
  accessToken: string;
  apiVersion?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class ShopifyClient {
  readonly shopDomain: string;
  readonly apiVersion: string;
  readonly readCapability = true;
  readonly mutationCapability = false;

  private readonly accessToken: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: ShopifyClientConfig) {
    this.shopDomain = normalizeAndValidateShopDomain(config.shopDomain);
    this.accessToken = config.accessToken;
    this.apiVersion = config.apiVersion || DEFAULT_SHOPIFY_API_VERSION;
    this.timeoutMs = config.timeoutMs || 10000;
    this.fetchFn = config.fetchFn || globalThis.fetch;
  }

  private get graphqlEndpoint(): string {
    return `https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`;
  }

  /**
   * Executes a GraphQL query against Shopify Admin API.
   * Handles timeouts, HTTP statuses, top-level GraphQL errors, and rate limit throttling.
   */
  async executeQuery<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<{ data: T; throttleStatus?: ShopifyThrottleStatus }> {
    // Check mutation fence
    const trimmed = query.trim();
    if (trimmed.startsWith('mutation') || /^\s*mutation\b/i.test(trimmed)) {
      throw new ShopifyMutationForbiddenError('GraphQL Mutation');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(this.graphqlEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': this.accessToken,
          'Accept': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      const isAbort = (err as Error)?.name === 'AbortError';
      if (isAbort) {
        throw new ShopifyClientError(`Shopify request to ${this.shopDomain} timed out after ${this.timeoutMs}ms`, {
          code: 'TIMEOUT',
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new ShopifyClientError(`Network failure communicating with Shopify: ${message}`, {
        code: 'NETWORK_ERROR',
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) {
      throw new ShopifyAuthenticationError(`Shopify authentication failed for ${this.shopDomain}: token invalid or expired`);
    }

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '2', 10);
      throw new ShopifyRateLimitError(`Shopify rate limit reached for ${this.shopDomain}`, retryAfter);
    }

    if (response.status === 403) {
      throw new ShopifyClientError(`Shopify access forbidden for ${this.shopDomain}: insufficient scope or permissions`, {
        status: 403,
        code: 'ACCESS_DENIED',
      });
    }

    if (!response.ok) {
      throw new ShopifyClientError(`Shopify returned HTTP status ${response.status}`, {
        status: response.status,
        code: 'HTTP_ERROR',
      });
    }

    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ShopifyClientError(`Failed to parse Shopify GraphQL response: ${message}`, {
        status: 200,
        code: 'MALFORMED_RESPONSE',
      });
    }

    // GraphQL error handling (top-level errors array)
    if (json.errors && Array.isArray(json.errors) && json.errors.length > 0) {
      const firstError = json.errors[0] as { message?: string };
      const message = firstError.message || 'Shopify GraphQL query returned errors';
      if (message.toLowerCase().includes('throttled')) {
        throw new ShopifyRateLimitError(message);
      }
      if (message.toLowerCase().includes('access denied') || message.toLowerCase().includes('unauthorized')) {
        throw new ShopifyAuthenticationError(message);
      }
      throw new ShopifyClientError(message, {
        status: 200,
        code: 'GRAPHQL_ERROR',
        errors: json.errors,
      });
    }

    let throttleStatus: ShopifyThrottleStatus | undefined;
    const extensions = json.extensions as { cost?: { throttleStatus?: ShopifyThrottleStatus } } | undefined;
    if (extensions?.cost?.throttleStatus) {
      throttleStatus = extensions.cost.throttleStatus;
    }

    return {
      data: json.data as T,
      throttleStatus,
    };
  }

  /**
   * Retrieves shop identity for domain and connection verification.
   */
  async getShopIdentity(): Promise<ShopifyShopIdentity> {
    const query = `
      query GetShopIdentity {
        shop {
          id
          myshopifyDomain
          name
        }
      }
    `;
    const res = await this.executeQuery<{ shop: ShopifyShopIdentity }>(query);
    return res.data.shop;
  }

  /**
   * Fetches an order by its GraphQL GID or numeric ID.
   */
  async getOrderById(orderGid: string): Promise<ShopifyOrderNode | null> {
    const formattedId = orderGid.startsWith('gid://') ? orderGid : `gid://shopify/Order/${orderGid}`;
    const query = `
      query GetOrderById($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          updatedAt
          displayFulfillmentStatus
          displayFinancialStatus
          cancelledAt
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                sku
                quantity
                title
              }
            }
          }
          fulfillments {
            id
            status
            createdAt
            updatedAt
            trackingInfo {
              number
              company
              url
            }
          }
        }
      }
    `;
    const res = await this.executeQuery<{ order: ShopifyOrderNode | null }>(query, { id: formattedId });
    return res.data.order;
  }

  /**
   * Fetches an order by reference name (e.g. "#1001").
   */
  async getOrderByReference(orderName: string): Promise<ShopifyOrderNode | null> {
    const page = await this.listRecentOrders({ first: 1, query: `name:${orderName}` });
    return page.orders.length > 0 ? page.orders[0] : null;
  }

  /**
   * Lists orders using cursor pagination with optional query filtering.
   */
  async listRecentOrders(options: {
    first?: number;
    after?: string;
    query?: string;
  } = {}): Promise<ShopifyOrdersPage> {
    const first = Math.min(options.first || 50, 250);
    const query = `
      query ListOrders($first: Int!, $after: String, $query: String) {
        orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: false) {
          pageInfo {
            hasNextPage
            hasPreviousPage
            endCursor
            startCursor
          }
          edges {
            cursor
            node {
              id
              name
              createdAt
              updatedAt
              displayFulfillmentStatus
              displayFinancialStatus
              cancelledAt
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    sku
                    quantity
                    title
                  }
                }
              }
              fulfillments {
                id
                status
                createdAt
                updatedAt
                trackingInfo {
                  number
                  company
                  url
                }
              }
            }
          }
        }
      }
    `;

    const res = await this.executeQuery<{
      orders?: {
        edges?: Array<{ node: ShopifyOrderNode }>;
        pageInfo?: {
          hasNextPage: boolean;
          hasPreviousPage: boolean;
          endCursor: string | null;
          startCursor: string | null;
        };
      };
    }>(query, {
      first,
      after: options.after || null,
      query: options.query || null,
    });

    const ordersEdge = res.data.orders?.edges || [];
    const orders: ShopifyOrderNode[] = ordersEdge.map((edge) => edge.node);
    const pageInfo = res.data.orders?.pageInfo || {
      hasNextPage: false,
      hasPreviousPage: false,
      endCursor: null,
      startCursor: null,
    };

    return {
      orders,
      pageInfo,
      throttleStatus: res.throttleStatus,
    };
  }

  // ==========================================
  // Strict Safety Fence: Mutations Explicitly Forbidden
  // ==========================================

  async updateTracking(): Promise<never> {
    throw new ShopifyMutationForbiddenError('updateTracking');
  }

  async createFulfillment(): Promise<never> {
    throw new ShopifyMutationForbiddenError('createFulfillment');
  }

  async adjustInventory(): Promise<never> {
    throw new ShopifyMutationForbiddenError('adjustInventory');
  }

  async cancelOrder(): Promise<never> {
    throw new ShopifyMutationForbiddenError('cancelOrder');
  }

  async createRefund(): Promise<never> {
    throw new ShopifyMutationForbiddenError('createRefund');
  }
}
