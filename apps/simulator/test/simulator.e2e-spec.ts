import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('External System Simulator E2E', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Reset simulator state before each test
    await request(app.getHttpServer()).post('/_simulator/reset').expect(200);
  });

  describe('1. Health Endpoint', () => {
    it('GET /health: returns simulator health with provider statuses', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      expect(res.body).toEqual({
        status: 'ok',
        service: 'simulator',
        providers: {
          shopify: 'ok',
          shipstation: 'ok',
          '3pl': 'ok',
        },
      });
    });
  });

  describe('2. Normal State & Healthy Order Scenario', () => {
    it('seeds and retrieves healthy order across all three providers', async () => {
      const seedRes = await request(app.getHttpServer())
        .post('/_simulator/seed/HEALTHY_ORDER')
        .expect(200);

      expect(seedRes.body.scenario).toBe('HEALTHY_ORDER');
      expect(seedRes.body.orderNumber).toBe('ORD-9001');

      // Check Shopify state
      const shopifyRes = await request(app.getHttpServer())
        .get('/shopify/orders/ORD-9001')
        .expect(200);
      expect(shopifyRes.body.paymentStatus).toBe('PAID');
      expect(shopifyRes.body.fulfillmentStatus).toBe('UNFULFILLED');

      // Check ShipStation state
      const shipRes = await request(app.getHttpServer())
        .get('/shipstation/shipments/by-order/ORD-9001')
        .expect(200);
      expect(shipRes.body.status).toBe('PENDING');
      expect(shipRes.body.carrier).toBe('UPS');

      // Check 3PL state
      const threePlRes = await request(app.getHttpServer())
        .get('/3pl/orders/ORD-9001')
        .expect(200);
      expect(threePlRes.body.status).toBe('RECEIVED');
    });
  });

  describe('3. Deterministic Rate Limiting (429 & Retry-After)', () => {
    it('returns HTTP 429 with Retry-After header and structured error', async () => {
      await request(app.getHttpServer())
        .post('/_simulator/faults')
        .send({
          fault: 'RETURN_429',
          provider: 'shopify',
          method: 'GET',
          remainingCount: 1,
          retryAfterSeconds: 8,
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get('/shopify/orders')
        .expect(429);

      expect(res.headers['retry-after']).toBe('8');
      expect(res.body.error).toMatchObject({
        code: 'RATE_LIMIT_EXCEEDED',
        retryable: true,
      });

      // Subsequent request succeeds normally (count was 1)
      await request(app.getHttpServer()).get('/shopify/orders').expect(200);
    });
  });

  describe('4. Temporary Server Failure (503)', () => {
    it('returns HTTP 503 Service Unavailable with retryable error flag', async () => {
      await request(app.getHttpServer())
        .post('/_simulator/faults')
        .send({
          fault: 'RETURN_503',
          provider: '3pl',
          remainingCount: 1,
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get('/3pl/orders')
        .expect(503);

      expect(res.body.error).toMatchObject({
        code: 'SIMULATED_SERVICE_UNAVAILABLE',
        retryable: true,
      });
    });
  });

  describe('5. Business Validation Errors (Invalid SKU & Address)', () => {
    it('rejects order with invalid SKU with HTTP 422 and retryable=false', async () => {
      const res = await request(app.getHttpServer())
        .post('/3pl/orders')
        .send({
          orderNumber: 'ORD-INV-SKU',
          lineItems: [{ sku: 'SKU-INVALID-99', name: 'Bad SKU Item', quantity: 1, price: 10 }],
        })
        .expect(422);

      expect(res.body.error).toMatchObject({
        code: 'INVALID_SKU',
        retryable: false,
      });
    });

    it('rejects order with invalid postal code with HTTP 422 and retryable=false', async () => {
      const res = await request(app.getHttpServer())
        .post('/3pl/orders')
        .send({
          orderNumber: 'ORD-INV-ADDR',
          shippingAddress: { street: '1 Elm', city: 'Nowhere', state: 'ZZ', postalCode: '00000', country: 'US' },
          lineItems: [{ sku: 'VALID-SKU', name: 'Good Item', quantity: 1, price: 10 }],
        })
        .expect(422);

      expect(res.body.error).toMatchObject({
        code: 'INVALID_ADDRESS',
        retryable: false,
      });
    });
  });

  describe('6. Missing Order & Search', () => {
    it('returns HTTP 404 when order is not found', async () => {
      const res = await request(app.getHttpServer())
        .get('/3pl/orders/ORD-NONEXISTENT')
        .expect(404);

      expect(res.body.error).toMatchObject({
        code: 'ORDER_NOT_FOUND',
        retryable: false,
      });
    });

    it('search endpoint finds order by reference', async () => {
      await request(app.getHttpServer())
        .post('/3pl/orders')
        .send({
          orderNumber: 'ORD-SEARCH-01',
          externalReference: 'EXT-SEARCH-REF-99',
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get('/3pl/orders/search?reference=EXT-SEARCH-REF-99')
        .expect(200);

      expect(res.body.orderNumber).toBe('ORD-SEARCH-01');
    });

    it('advances warehouse order through canonical lifecycle states and rejects PROCESSING', async () => {
      // 1. Create initial warehouse order
      await request(app.getHttpServer())
        .post('/3pl/orders')
        .send({
          orderNumber: 'ORD-STATUS-01',
          externalReference: 'EXT-STATUS-01',
        })
        .expect(201);

      // 2. Rejects vague status PROCESSING
      const badRes = await request(app.getHttpServer())
        .patch('/3pl/orders/ORD-STATUS-01/status')
        .send({ status: 'PROCESSING' })
        .expect(400);

      expect(badRes.body.error).toMatchObject({
        code: 'INVALID_STATUS',
        retryable: false,
      });

      // 3. Advances through canonical progression: PENDING_FULFILLMENT -> PICKING -> PACKED -> SHIPPED -> DELIVERED
      const progression = ['PENDING_FULFILLMENT', 'PICKING', 'PACKED', 'SHIPPED', 'DELIVERED'] as const;
      for (const nextStatus of progression) {
        const updateRes = await request(app.getHttpServer())
          .patch('/3pl/orders/ORD-STATUS-01/status')
          .send({
            status: nextStatus,
            ...(nextStatus === 'SHIPPED' ? { trackingNumber: 'TRK-CANONICAL-01', carrier: 'FedEx' } : {}),
          })
          .expect(200);
        expect(updateRes.body.status).toBe(nextStatus);
      }
    });
  });

  describe('7. Discrepancy Scenarios: Tracking & Inventory Mismatches', () => {
    it('TRACKING_MISSING_IN_SHOPIFY: tracking exists in shipping simulator but absent in Shopify', async () => {
      await request(app.getHttpServer())
        .post('/_simulator/seed/TRACKING_MISSING_IN_SHOPIFY')
        .expect(200);

      const shipRes = await request(app.getHttpServer())
        .get('/shipstation/shipments/by-order/ORD-9002')
        .expect(200);
      expect(shipRes.body.trackingNumber).toBe('TRK-UPS-987654321');

      const shopifyRes = await request(app.getHttpServer())
        .get('/shopify/orders/ORD-9002')
        .expect(200);
      expect(shopifyRes.body.trackingNumber).toBeUndefined();
      expect(shopifyRes.body.fulfillmentStatus).toBe('UNFULFILLED');
    });

    it('SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY: 3PL is shipped while Shopify is unfulfilled', async () => {
      await request(app.getHttpServer())
        .post('/_simulator/seed/SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY')
        .expect(200);

      const threePlRes = await request(app.getHttpServer())
        .get('/3pl/orders/ORD-9005')
        .expect(200);
      expect(threePlRes.body.status).toBe('SHIPPED');
      expect(threePlRes.body.trackingNumber).toBe('TRK-FDX-554433');

      const shopifyRes = await request(app.getHttpServer())
        .get('/shopify/orders/ORD-9005')
        .expect(200);
      expect(shopifyRes.body.fulfillmentStatus).toBe('UNFULFILLED');
    });

    it('INVENTORY_MISMATCH: preserves independent quantities in Shopify vs 3PL', async () => {
      await request(app.getHttpServer())
        .post('/_simulator/seed/INVENTORY_MISMATCH')
        .expect(200);

      const shopifyInv = await request(app.getHttpServer())
        .get('/shopify/inventory/SKU-MISMATCH-99')
        .expect(200);
      expect(shopifyInv.body.quantity).toBe(12);

      const threePlInv = await request(app.getHttpServer())
        .get('/3pl/inventory/SKU-MISMATCH-99')
        .expect(200);
      expect(threePlInv.body.quantity).toBe(7);
    });
  });

  describe('8. Duplicate Order Simulation', () => {
    it('DUPLICATE_RISK: rejects second submission of existing order with 409', async () => {
      await request(app.getHttpServer())
        .post('/_simulator/seed/DUPLICATE_RISK')
        .expect(200);

      const existing = await request(app.getHttpServer())
        .get('/3pl/orders/ORD-9006')
        .expect(200);
      expect(existing.body.status).toBe('PICKING');

      const res = await request(app.getHttpServer())
        .post('/3pl/orders')
        .send({
          orderNumber: 'ORD-9006',
        })
        .expect(409);

      expect(res.body.error).toMatchObject({
        code: 'DUPLICATE_ORDER',
        retryable: false,
      });
    });
  });

  describe('9. Ambiguous Timeout (COMMIT_THEN_TIMEOUT)', () => {
    it('mutation is committed, client receives timeout, subsequent GET proves committed state', async () => {
      // Injects COMMIT_THEN_TIMEOUT
      await request(app.getHttpServer())
        .post('/_simulator/seed/AMBIGUOUS_TIMEOUT')
        .expect(200);

      // Client submits order; receives 504 Gateway Timeout
      const postRes = await request(app.getHttpServer())
        .post('/3pl/orders')
        .send({
          orderNumber: 'ORD-TIMEOUT-888',
          customer: { name: 'Ambiguous Client', email: 'client@example.com' },
          lineItems: [{ sku: 'SKU-AMBIGUOUS', name: 'Item', quantity: 1, price: 20 }],
        })
        .expect(504);

      expect(postRes.body.error).toMatchObject({
        code: 'COMMIT_THEN_TIMEOUT',
        retryable: true,
      });

      // Subsequent GET query proves the order was committed to the warehouse despite the client timeout!
      const getRes = await request(app.getHttpServer())
        .get('/3pl/orders/ORD-TIMEOUT-888')
        .expect(200);

      expect(getRes.body.orderNumber).toBe('ORD-TIMEOUT-888');
      expect(getRes.body.status).toBe('RECEIVED');
    });
  });

  describe('10. Slow Response & Timeout Simulation', () => {
    it('SLOW_RESPONSE: succeeds after delay', async () => {
      await request(app.getHttpServer())
        .post('/_simulator/faults')
        .send({
          fault: 'SLOW_RESPONSE',
          provider: 'shopify',
          remainingCount: 1,
          delayMs: 100,
        })
        .expect(201);

      const res = await request(app.getHttpServer()).get('/shopify/orders').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('TIMEOUT: fails with 504 after delay', async () => {
      await request(app.getHttpServer())
        .post('/_simulator/faults')
        .send({
          fault: 'TIMEOUT',
          provider: 'shipstation',
          remainingCount: 1,
          delayMs: 100,
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get('/shipstation/shipments')
        .expect(504);

      expect(res.body.error).toMatchObject({
        code: 'GATEWAY_TIMEOUT',
        retryable: true,
      });
    });
  });

  describe('11. Safe Reset Isolation', () => {
    it('resets simulator state without touching any other service', async () => {
      await request(app.getHttpServer())
        .post('/_simulator/seed/HEALTHY_ORDER')
        .expect(200);

      // Verify order exists
      await request(app.getHttpServer())
        .get('/shopify/orders/ORD-9001')
        .expect(200);

      // Reset
      const resetRes = await request(app.getHttpServer())
        .post('/_simulator/reset')
        .expect(200);

      expect(resetRes.body.success).toBe(true);

      // Verify state is clean
      const stateRes = await request(app.getHttpServer())
        .get('/_simulator/state')
        .expect(200);

      expect(stateRes.body.shopify.ordersCount).toBe(0);
      expect(stateRes.body.shipstation.shipmentsCount).toBe(0);
      expect(stateRes.body.threePl.ordersCount).toBe(0);
      expect(stateRes.body.faultRulesCount).toBe(0);
    });
  });
});