export const SHIPSTATION_V2_BASE_URL = 'https://api.shipstation.com/v2';

export class ShipStationError extends Error {
  readonly statusCode?: number;
  readonly isTransient: boolean;

  constructor(message: string, statusCode?: number, isTransient = false) {
    super(message);
    this.name = 'ShipStationError';
    this.statusCode = statusCode;
    this.isTransient = isTransient;
  }
}

export class ShipStationUnauthorizedError extends ShipStationError {
  constructor(message = 'Invalid or expired ShipStation API key (401)') {
    super(message, 401, false);
    this.name = 'ShipStationUnauthorizedError';
  }
}

export class ShipStationForbiddenError extends ShipStationError {
  constructor(message = 'Access forbidden to ShipStation resource (403)') {
    super(message, 403, false);
    this.name = 'ShipStationForbiddenError';
  }
}

export class ShipStationNotFoundError extends ShipStationError {
  constructor(message = 'ShipStation resource not found (404)') {
    super(message, 404, false);
    this.name = 'ShipStationNotFoundError';
  }
}

export class ShipStationRateLimitError extends ShipStationError {
  readonly retryAfterSeconds: number;

  constructor(message = 'ShipStation API rate limit exceeded (429)', retryAfterSeconds = 5) {
    super(message, 429, true);
    this.name = 'ShipStationRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ShipStationServerError extends ShipStationError {
  constructor(message = 'ShipStation internal server error', statusCode = 500) {
    super(message, statusCode, true);
    this.name = 'ShipStationServerError';
  }
}

export class ShipStationSafetyError extends Error {
  constructor(action: string) {
    super(`ShipStation mutation blocked by safety policy: '${action}' is strictly forbidden in read-only mode.`);
    this.name = 'ShipStationSafetyError';
  }
}

export interface ShipStationRawShipment {
  shipment_id: string | number;
  shipment_number?: string;
  external_shipment_id?: string;
  external_order_id?: string;
  order_number?: string;
  shipment_status: 'pending' | 'processing' | 'label_purchased' | 'cancelled' | string;
  carrier_code?: string;
  service_code?: string;
  tracking_number?: string;
  ship_date?: string;
  created_at: string;
  modified_at: string;
  [key: string]: unknown;
}

export interface ShipStationShipmentsResponse {
  shipments: ShipStationRawShipment[];
  total: number;
  page: number;
  pages: number;
}

export interface ListShipmentsOptions {
  page?: number;
  pageSize?: number;
  createdAtStart?: string;
  createdAtEnd?: string;
  modifiedAtStart?: string;
  modifiedAtEnd?: string;
  sortBy?: 'created_at' | 'modified_at';
  sortDir?: 'asc' | 'desc';
}

export interface ShipStationRawLabelPackage {
  package_id?: string | number;
  tracking_number?: string;
  weight?: unknown;
  dimensions?: unknown;
}

export interface ShipStationRawLabel {
  label_id: string | number;
  shipment_id: string | number;
  external_shipment_id?: string;
  tracking_number?: string;
  carrier_code?: string;
  carrier_id?: string;
  service_code?: string;
  status?: 'completed' | 'voided' | 'processing' | string;
  voided?: boolean;
  tracking_status?: string;
  created_at?: string;
  packages?: ShipStationRawLabelPackage[];
  [key: string]: unknown;
}

export interface ShipStationLabelsResponse {
  labels: ShipStationRawLabel[];
  total: number;
  page: number;
  pages: number;
}

export interface ListLabelsOptions {
  shipmentId?: string | number;
  externalShipmentId?: string;
  page?: number;
  pageSize?: number;
  createdAtStart?: string;
  createdAtEnd?: string;
  sortBy?: 'created_at';
  sortDir?: 'asc' | 'desc';
}

import { ShipStationRateLimiter } from './rate-limiter';

export interface ShipStationClientOptions {
  apiKey: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  rateLimiter?: ShipStationRateLimiter;
}

export class ShipStationClient {
  readonly readCapability = true;
  readonly mutationCapability = false;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly rateLimiter: ShipStationRateLimiter;

  constructor(options: ShipStationClientOptions) {
    if (!options.apiKey || options.apiKey.trim() === '') {
      throw new ShipStationError('ShipStation apiKey is required and cannot be empty');
    }
    this.apiKey = options.apiKey.trim();
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.rateLimiter = options.rateLimiter ?? ShipStationRateLimiter.getDefault();
  }

  getRateLimiter(): ShipStationRateLimiter {
    return this.rateLimiter;
  }

  /**
   * Tests API key validity against ShipStation V2.
   * Performs a lightweight read: GET /v2/shipments?page=1&page_size=1
   */
  async testConnection(): Promise<{ valid: boolean; totalShipments: number }> {
    const res = await this.listShipments({ page: 1, pageSize: 1 });
    return {
      valid: true,
      totalShipments: res.total ?? 0,
    };
  }

  /**
   * Lists shipments with pagination and date filters.
   * GET /v2/shipments
   */
  async listShipments(options: ListShipmentsOptions = {}): Promise<ShipStationShipmentsResponse> {
    const params = new URLSearchParams();
    if (options.page) params.set('page', String(options.page));
    if (options.pageSize) params.set('page_size', String(options.pageSize));
    if (options.createdAtStart) params.set('created_at_start', options.createdAtStart);
    if (options.createdAtEnd) params.set('created_at_end', options.createdAtEnd);
    if (options.modifiedAtStart) params.set('modified_at_start', options.modifiedAtStart);
    if (options.modifiedAtEnd) params.set('modified_at_end', options.modifiedAtEnd);
    if (options.sortBy) params.set('sort_by', options.sortBy);
    if (options.sortDir) params.set('sort_dir', options.sortDir);

    const query = params.toString();
    const endpoint = query ? `/v2/shipments?${query}` : '/v2/shipments';

    return this.request<ShipStationShipmentsResponse>(endpoint);
  }

  /**
   * Retrieves single shipment by ShipStation shipment ID.
   * GET /v2/shipments/{shipment_id}
   */
  async getShipmentById(shipmentId: string): Promise<ShipStationRawShipment> {
    if (!shipmentId) {
      throw new ShipStationError('shipmentId is required');
    }
    return this.request<ShipStationRawShipment>(`/v2/shipments/${encodeURIComponent(shipmentId)}`);
  }

  /**
   * Retrieves single shipment by external shipment ID.
   * GET /v2/shipments/external_shipment_id/{external_shipment_id}
   */
  async getShipmentByExternalId(externalShipmentId: string): Promise<ShipStationRawShipment> {
    if (!externalShipmentId) {
      throw new ShipStationError('externalShipmentId is required');
    }
    return this.request<ShipStationRawShipment>(
      `/v2/shipments/external_shipment_id/${encodeURIComponent(externalShipmentId)}`,
    );
  }

  /**
   * Lists labels with pagination and filters.
   * GET /v2/labels
   */
  async listLabels(options: ListLabelsOptions = {}): Promise<ShipStationLabelsResponse> {
    const params = new URLSearchParams();
    if (options.shipmentId) params.set('shipment_id', String(options.shipmentId));
    if (options.externalShipmentId) params.set('external_shipment_id', options.externalShipmentId);
    if (options.page) params.set('page', String(options.page));
    if (options.pageSize) params.set('page_size', String(options.pageSize));
    if (options.createdAtStart) params.set('created_at_start', options.createdAtStart);
    if (options.createdAtEnd) params.set('created_at_end', options.createdAtEnd);
    if (options.sortBy) params.set('sort_by', options.sortBy);
    if (options.sortDir) params.set('sort_dir', options.sortDir);

    const query = params.toString();
    const endpoint = query ? `/v2/labels?${query}` : '/v2/labels';

    return this.request<ShipStationLabelsResponse>(endpoint);
  }

  /**
   * Retrieves single label by ShipStation label ID.
   * GET /v2/labels/{label_id}
   */
  async getLabelById(labelId: string): Promise<ShipStationRawLabel> {
    if (!labelId) {
      throw new ShipStationError('labelId is required');
    }
    return this.request<ShipStationRawLabel>(`/v2/labels/${encodeURIComponent(labelId)}`);
  }

  /**
   * Retrieves labels by external shipment ID.
   * GET /v2/labels/external_shipment_id/{external_shipment_id}
   */
  async getLabelsByExternalShipmentId(externalShipmentId: string): Promise<ShipStationRawLabel[]> {
    if (!externalShipmentId) {
      throw new ShipStationError('externalShipmentId is required');
    }
    const res = await this.request<ShipStationLabelsResponse | ShipStationRawLabel[]>(
      `/v2/labels/external_shipment_id/${encodeURIComponent(externalShipmentId)}`,
    );
    if (Array.isArray(res)) {
      return res;
    }
    return res.labels || [];
  }

  // ==========================================
  // Strictly Forbidden Mutation Safety Blockers
  // ==========================================

  createShipment(): never {
    throw new ShipStationSafetyError('createShipment');
  }

  updateShipment(): never {
    throw new ShipStationSafetyError('updateShipment');
  }

  voidLabel(): never {
    throw new ShipStationSafetyError('voidLabel');
  }

  purchaseLabel(): never {
    throw new ShipStationSafetyError('purchaseLabel');
  }

  createLabel(): never {
    throw new ShipStationSafetyError('createLabel');
  }

  returnLabel(): never {
    throw new ShipStationSafetyError('returnLabel');
  }

  refundLabel(): never {
    throw new ShipStationSafetyError('refundLabel');
  }

  cancelShipment(): never {
    throw new ShipStationSafetyError('cancelShipment');
  }

  /**
   * Centralized HTTP GET executor with fixed base URL, provider rate coordination, and secret redaction.
   */
  private async request<T>(path: string): Promise<T> {
    return this.rateLimiter.execute<T>(async () => {
      const url = `${SHIPSTATION_V2_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

      const headers: Record<string, string> = {
        'api-key': this.apiKey,
        'Accept': 'application/json',
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        if (err instanceof Error && err.name === 'AbortError') {
          throw new ShipStationServerError(`ShipStation request timed out after ${this.timeoutMs}ms`, 504);
        }
        const message = err instanceof Error ? this.redactSecret(err.message) : 'Network error';
        throw new ShipStationServerError(`Failed to connect to ShipStation: ${message}`, 503);
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          errorBody = 'Unable to read error response';
        }
        const safeErrorBody = this.redactSecret(errorBody);

        if (response.status === 401) {
          throw new ShipStationUnauthorizedError(`ShipStation 401 Unauthorized: ${safeErrorBody}`);
        }
        if (response.status === 403) {
          throw new ShipStationForbiddenError(`ShipStation 403 Forbidden: ${safeErrorBody}`);
        }
        if (response.status === 404) {
          throw new ShipStationNotFoundError(`ShipStation 404 Not Found: ${safeErrorBody}`);
        }
        if (response.status === 429) {
          const retryAfterHeader = response.headers?.get ? response.headers.get('retry-after') : null;
          let retryAfterSeconds = 5;
          if (retryAfterHeader) {
            const parsed = parseInt(retryAfterHeader, 10);
            if (!isNaN(parsed) && parsed > 0) {
              retryAfterSeconds = parsed;
            }
          }
          // Coordinate provider rate limit globally across all callers
          this.rateLimiter.recordRateLimit(retryAfterSeconds);
          throw new ShipStationRateLimitError(
            `ShipStation 429 Rate Limit Exceeded: ${safeErrorBody}`,
            retryAfterSeconds,
          );
        }
        if (response.status >= 500) {
          throw new ShipStationServerError(
            `ShipStation ${response.status} Server Error: ${safeErrorBody}`,
            response.status,
          );
        }

        throw new ShipStationError(`ShipStation HTTP ${response.status}: ${safeErrorBody}`, response.status, false);
      }

      try {
        return (await response.json()) as T;
      } catch (err: unknown) {
        throw new ShipStationError('Failed to parse ShipStation JSON response', response.status, false);
      }
    });
  }

  private redactSecret(text: string): string {
    if (!this.apiKey) return text;
    return text.split(this.apiKey).join('[REDACTED_API_KEY]');
  }
}
