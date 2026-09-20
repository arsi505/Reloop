import {
  ShipStationClient,
  ShipStationError,
  ShipStationUnauthorizedError,
  ShipStationForbiddenError,
  ShipStationNotFoundError,
  ShipStationRateLimitError,
  ShipStationServerError,
  ShipStationSafetyError,
  SHIPSTATION_V2_BASE_URL,
} from './shipstation-client';
import { ShipStationRateLimiter } from './rate-limiter';

describe('ShipStationClient', () => {
  const apiKey = 'test_ss_api_key_xyz987';

  beforeEach(() => {
    ShipStationRateLimiter.resetDefault();
  });

  it('enforces fixed base URL and provides readCapability=true, mutationCapability=false', () => {
    const client = new ShipStationClient({ apiKey });
    expect(client.readCapability).toBe(true);
    expect(client.mutationCapability).toBe(false);
    expect(SHIPSTATION_V2_BASE_URL).toBe('https://api.shipstation.com/v2');
  });

  it('rejects initialization with empty API key', () => {
    expect(() => new ShipStationClient({ apiKey: '' })).toThrow(ShipStationError);
    expect(() => new ShipStationClient({ apiKey: '   ' })).toThrow(ShipStationError);
  });

  describe('testConnection', () => {
    it('calls GET /v2/shipments?page=1&page_size=1 and returns validity', async () => {
      let calledUrl = '';
      let calledHeaders: Record<string, string> = {};

      const mockFetch: typeof fetch = async (input, init) => {
        calledUrl = String(input);
        calledHeaders = (init?.headers as Record<string, string>) || {};
        return new Response(JSON.stringify({ shipments: [], total: 42, page: 1, pages: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const client = new ShipStationClient({ apiKey, fetchFn: mockFetch });
      const res = await client.testConnection();

      expect(calledUrl).toBe('https://api.shipstation.com/v2/v2/shipments?page=1&page_size=1');
      expect(calledHeaders['api-key']).toBe(apiKey);
      expect(res.valid).toBe(true);
      expect(res.totalShipments).toBe(42);
    });
  });

  describe('listShipments', () => {
    it('passes pagination and filtering query parameters', async () => {
      let calledUrl = '';

      const mockFetch: typeof fetch = async (input) => {
        calledUrl = String(input);
        return new Response(
          JSON.stringify({
            shipments: [
              {
                shipment_id: 'se-100',
                shipment_number: 'SHIP-100',
                external_order_id: '1001',
                shipment_status: 'label_purchased',
                tracking_number: '9400123456789',
                carrier_code: 'usps',
                created_at: '2026-09-20T00:00:00Z',
                modified_at: '2026-09-20T01:00:00Z',
              },
            ],
            total: 1,
            page: 2,
            pages: 5,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = new ShipStationClient({ apiKey, fetchFn: mockFetch });
      const res = await client.listShipments({
        page: 2,
        pageSize: 25,
        modifiedAtStart: '2026-09-19T00:00:00Z',
        sortBy: 'modified_at',
        sortDir: 'asc',
      });

      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('page_size=25');
      expect(calledUrl).toContain('modified_at_start=2026-09-19T00%3A00%3A00Z');
      expect(calledUrl).toContain('sort_by=modified_at');
      expect(calledUrl).toContain('sort_dir=asc');
      expect(res.shipments.length).toBe(1);
      expect(res.shipments[0].shipment_id).toBe('se-100');
    });
  });

  describe('getShipmentById & getShipmentByExternalId', () => {
    it('fetches shipment by ID correctly', async () => {
      let calledUrl = '';
      const mockFetch: typeof fetch = async (input) => {
        calledUrl = String(input);
        return new Response(
          JSON.stringify({ shipment_id: 'se-999', shipment_status: 'processing' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = new ShipStationClient({ apiKey, fetchFn: mockFetch });
      const shipment = await client.getShipmentById('se-999');
      expect(calledUrl).toBe('https://api.shipstation.com/v2/v2/shipments/se-999');
      expect(shipment.shipment_id).toBe('se-999');
    });

    it('fetches shipment by external shipment ID correctly', async () => {
      let calledUrl = '';
      const mockFetch: typeof fetch = async (input) => {
        calledUrl = String(input);
        return new Response(
          JSON.stringify({ shipment_id: 'se-888', external_shipment_id: 'ext-888' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = new ShipStationClient({ apiKey, fetchFn: mockFetch });
      const shipment = await client.getShipmentByExternalId('ext-888');
      expect(calledUrl).toBe(
        'https://api.shipstation.com/v2/v2/shipments/external_shipment_id/ext-888',
      );
      expect(shipment.external_shipment_id).toBe('ext-888');
    });
  });

  describe('Error handling & Secret Redaction', () => {
    it('maps 401 to ShipStationUnauthorizedError and redacts API key', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(`Invalid key: ${apiKey}`, { status: 401 });
      };
      const client = new ShipStationClient({ apiKey, fetchFn: mockFetch });

      await expect(client.testConnection()).rejects.toThrow(ShipStationUnauthorizedError);
      try {
        await client.testConnection();
      } catch (err: any) {
        expect(err.message).not.toContain(apiKey);
        expect(err.message).toContain('[REDACTED_API_KEY]');
      }
    });

    it('maps 403 to ShipStationForbiddenError', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('Forbidden plan', { status: 403 });
      };
      const client = new ShipStationClient({ apiKey, fetchFn: mockFetch });
      await expect(client.testConnection()).rejects.toThrow(ShipStationForbiddenError);
    });

    it('maps 404 to ShipStationNotFoundError', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('Not found', { status: 404 });
      };
      const client = new ShipStationClient({ apiKey, fetchFn: mockFetch });
      await expect(client.getShipmentById('unknown')).rejects.toThrow(ShipStationNotFoundError);
    });

    it('maps 429 to ShipStationRateLimitError with Retry-After header', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('Too Many Requests', {
          status: 429,
          headers: { 'retry-after': '12' },
        });
      };
      const client = new ShipStationClient({ apiKey, fetchFn: mockFetch });

      try {
        await client.listShipments();
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ShipStationRateLimitError);
        expect(err.retryAfterSeconds).toBe(12);
        expect(err.isTransient).toBe(true);
      }
    });

    it('maps 500 to ShipStationServerError and marks it transient', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('Internal error', { status: 500 });
      };
      const client = new ShipStationClient({ apiKey, fetchFn: mockFetch });

      try {
        await client.listShipments();
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ShipStationServerError);
        expect(err.statusCode).toBe(500);
        expect(err.isTransient).toBe(true);
      }
    });
  });

  describe('Label Read Operations', () => {
    it('listLabels queries GET /v2/labels with shipment filter', async () => {
      let calledUrl = '';
      const mockFetch: typeof fetch = async (input) => {
        calledUrl = String(input);
        return new Response(
          JSON.stringify({
            labels: [
              {
                label_id: 'lbl-100',
                shipment_id: 'se-100',
                tracking_number: '9400123456789',
                status: 'completed',
                voided: false,
                created_at: '2026-09-20T00:00:00Z',
              },
            ],
            total: 1,
            page: 1,
            pages: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = new ShipStationClient({ apiKey, fetchFn: mockFetch });
      const res = await client.listLabels({ shipmentId: 'se-100' });

      expect(calledUrl).toBe('https://api.shipstation.com/v2/v2/labels?shipment_id=se-100');
      expect(res.labels.length).toBe(1);
      expect(res.labels[0].label_id).toBe('lbl-100');
      expect(res.labels[0].tracking_number).toBe('9400123456789');
    });

    it('getLabelById retrieves a single label', async () => {
      let calledUrl = '';
      const mockFetch: typeof fetch = async (input) => {
        calledUrl = String(input);
        return new Response(
          JSON.stringify({
            label_id: 'lbl-500',
            shipment_id: 'se-500',
            tracking_number: '1Z9999999999999999',
            status: 'completed',
            voided: false,
            created_at: '2026-09-20T00:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = new ShipStationClient({ apiKey, fetchFn: mockFetch });
      const label = await client.getLabelById('lbl-500');

      expect(calledUrl).toBe('https://api.shipstation.com/v2/v2/labels/lbl-500');
      expect(label.label_id).toBe('lbl-500');
    });

    it('getLabelsByExternalShipmentId retrieves labels by external shipment ID', async () => {
      let calledUrl = '';
      const mockFetch: typeof fetch = async (input) => {
        calledUrl = String(input);
        return new Response(
          JSON.stringify([
            {
              label_id: 'lbl-600',
              external_shipment_id: 'ext-600',
              tracking_number: '940099999999',
              status: 'completed',
              voided: false,
              created_at: '2026-09-20T00:00:00Z',
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = new ShipStationClient({ apiKey, fetchFn: mockFetch });
      const labels = await client.getLabelsByExternalShipmentId('ext-600');

      expect(calledUrl).toBe(
        'https://api.shipstation.com/v2/v2/labels/external_shipment_id/ext-600',
      );
      expect(labels.length).toBe(1);
      expect(labels[0].label_id).toBe('lbl-600');
    });
  });

  describe('Strict Mutation Blockers', () => {
    it('strictly throws ShipStationSafetyError on mutation method calls', () => {
      const client = new ShipStationClient({ apiKey });
      expect(() => client.createShipment()).toThrow(ShipStationSafetyError);
      expect(() => client.updateShipment()).toThrow(ShipStationSafetyError);
      expect(() => client.voidLabel()).toThrow(ShipStationSafetyError);
      expect(() => client.purchaseLabel()).toThrow(ShipStationSafetyError);
      expect(() => client.createLabel()).toThrow(ShipStationSafetyError);
      expect(() => client.returnLabel()).toThrow(ShipStationSafetyError);
      expect(() => client.refundLabel()).toThrow(ShipStationSafetyError);
      expect(() => client.cancelShipment()).toThrow(ShipStationSafetyError);
    });
  });

  describe('Provider-Wide Rate Coordination & Thundering-Herd Defense', () => {
    it('coordinates requests, honors 429 Retry-After, and prevents thundering herd', async () => {
      const rateLimiter = new ShipStationRateLimiter({ maxConcurrency: 1, minIntervalMs: 5 });
      let callCount = 0;
      const callTimestamps: number[] = [];

      const mockFetch: typeof fetch = async () => {
        callCount++;
        callTimestamps.push(Date.now());
        if (callCount === 1) {
          // First call encounters 429 with Retry-After 1 second
          return new Response('Rate limited', {
            status: 429,
            headers: { 'retry-after': '1' },
          });
        }
        return new Response(
          JSON.stringify({ shipments: [], total: 0, page: 1, pages: 1 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = new ShipStationClient({ apiKey, fetchFn: mockFetch, rateLimiter });

      // Launch 4 simultaneous reads
      const startTime = Date.now();
      const p1 = client.listShipments().catch((err) => err);
      const p2 = client.listShipments().catch((err) => err);
      const p3 = client.listShipments().catch((err) => err);
      const p4 = client.listShipments().catch((err) => err);

      const [r1, r2, r3, r4] = await Promise.all([p1, p2, p3, p4]);

      // p1 threw ShipStationRateLimitError
      expect(r1).toBeInstanceOf(ShipStationRateLimitError);
      expect(r1.retryAfterSeconds).toBe(1);

      // Subsequent callers were held back by the rate coordinator during the 1s Retry-After backoff
      expect(r2).toHaveProperty('shipments');
      expect(r3).toHaveProperty('shipments');
      expect(r4).toHaveProperty('shipments');

      // Verify that subsequent calls waited until after Retry-After before executing against provider
      const subsequentCalls = callTimestamps.slice(1);
      expect(subsequentCalls.length).toBe(3);
      for (const t of subsequentCalls) {
        expect(t - startTime).toBeGreaterThanOrEqual(950);
      }
    });

    it('shares common rate limiter across multiple client instances by default', () => {
      const clientA = new ShipStationClient({ apiKey });
      const clientB = new ShipStationClient({ apiKey });
      expect(clientA.getRateLimiter()).toBe(clientB.getRateLimiter());
    });
  });
});
