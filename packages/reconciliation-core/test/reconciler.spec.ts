import {
  reconcileOrder,
  DeterministicMatcher,
  NormalizedOrderSnapshot,
} from '../src';

describe('Deterministic Reconciliation Core', () => {
  const baseEvaluationTime = '2026-09-19T12:00:00.000Z';

  const createHealthySnapshot = (): NormalizedOrderSnapshot => ({
    organizationId: 'org-100',
    orderNumber: 'ORD-1001',
    shopify: {
      id: 'shp-1001',
      orderNumber: 'ORD-1001',
      fulfillmentStatus: 'FULFILLED',
      trackingNumber: 'TRK-1001',
      carrier: 'FedEx',
      lineItems: [{ sku: 'SKU-A', quantity: 2 }],
      addressValid: true,
      createdAt: '2026-09-19T08:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    warehouse: {
      id: 'wh-1001',
      orderNumber: 'ORD-1001',
      externalReference: 'shp-1001',
      status: 'SHIPPED',
      trackingNumber: 'TRK-1001',
      carrier: 'FedEx',
      lineItems: [{ sku: 'SKU-A', quantity: 2 }],
      createdAt: '2026-09-19T08:30:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    shipstation: {
      id: 'ss-1001',
      orderNumber: 'ORD-1001',
      carrier: 'FedEx',
      trackingNumber: 'TRK-1001',
      status: 'IN_TRANSIT',
      createdAt: '2026-09-19T09:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    inventory: [
      { sku: 'SKU-A', shopifyQuantity: 50, warehouseQuantity: 50 },
    ],
  });

  describe('1. Healthy Order', () => {
    it('returns zero findings for a fully consistent and fulfilled order', () => {
      const snapshot = createHealthySnapshot();
      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(0);
    });

    it('repeated scans on healthy order consistently produce zero findings', () => {
      const snapshot = createHealthySnapshot();
      const run1 = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      const run2 = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(run1).toEqual(run2);
      expect(run1).toHaveLength(0);
    });
  });

  describe('2. Deterministic Matching Engine', () => {
    it('returns MATCH when configured identifiers agree and no conflicts exist', () => {
      const snapshot = createHealthySnapshot();
      const result = DeterministicMatcher.matchShopifyToWarehouse(snapshot);
      expect(result.status).toBe('MATCH');
      expect(result.conflictingIdentifiers).toHaveLength(0);
      expect(result.matchedIdentifiers).toContain('orderNumber:ORD-1001');
      expect(result.matchedIdentifiers).toContain('externalReference:shp-1001');
    });

    it('returns NO_MATCH when target representation does not exist', () => {
      const snapshot = createHealthySnapshot();
      delete snapshot.warehouse;
      const result = DeterministicMatcher.matchShopifyToWarehouse(snapshot);
      expect(result.status).toBe('NO_MATCH');
      expect(result.candidateCount).toBe(0);
    });

    it('returns AMBIGUOUS when multiple candidate orders exist in warehouse', () => {
      const snapshot = createHealthySnapshot();
      snapshot.warehouse!.candidateOrders = [
        { id: 'wh-1', orderNumber: 'ORD-1001', status: 'RECEIVED' },
        { id: 'wh-2', orderNumber: 'ORD-1001', status: 'PICKING' },
      ];
      const result = DeterministicMatcher.matchShopifyToWarehouse(snapshot);
      expect(result.status).toBe('AMBIGUOUS');
      expect(result.candidateCount).toBe(2);
    });

    it('returns CONFLICT when external reference belongs to a different order', () => {
      const snapshot = createHealthySnapshot();
      snapshot.warehouse!.externalReference = 'shp-DIFFERENT-ORDER';
      const result = DeterministicMatcher.matchShopifyToWarehouse(snapshot);
      expect(result.status).toBe('CONFLICT');
      expect(result.conflictingIdentifiers.length).toBeGreaterThan(0);
    });
  });

  describe('3. Temporary API Failure & Integration Health Gating', () => {
    it('detects HTTP 429 rate limit as TEMPORARY_API_FAILURE (AUTO_RECOVER)', () => {
      const snapshot = createHealthySnapshot();
      snapshot.shopify!.error = {
        provider: 'Shopify',
        statusCode: 429,
        errorCode: 'RATE_LIMITED',
        message: 'Too many requests to Shopify API',
        isTransient: true,
      };

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('TEMPORARY_API_FAILURE');
      expect(findings[0].recoveryLevel).toBe('AUTO_RECOVER');
      expect(findings[0].evidence.disagreements.httpStatus.observed).toBe(429);
    });

    it('detects HTTP 503 service unavailable as TEMPORARY_API_FAILURE (AUTO_RECOVER)', () => {
      const snapshot = createHealthySnapshot();
      snapshot.warehouse!.error = {
        provider: 'Generic3PL',
        statusCode: 503,
        errorCode: 'SERVICE_UNAVAILABLE',
        message: '3PL warehouse portal temporarily unavailable',
        isTransient: true,
      };

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('TEMPORARY_API_FAILURE');
      expect(findings[0].recoveryLevel).toBe('AUTO_RECOVER');
    });

    it('detects timeout as TEMPORARY_API_FAILURE (AUTO_RECOVER)', () => {
      const snapshot = createHealthySnapshot();
      snapshot.shipstation!.error = {
        provider: 'ShipStation',
        errorCode: 'TIMEOUT',
        message: 'Gateway timeout contacting ShipStation',
        isTransient: true,
      };

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('TEMPORARY_API_FAILURE');
      expect(findings[0].recoveryLevel).toBe('AUTO_RECOVER');
    });

    it('does NOT classify permanent/auth error as TEMPORARY_API_FAILURE', () => {
      const snapshot = createHealthySnapshot();
      snapshot.shopify!.error = {
        provider: 'Shopify',
        statusCode: 401,
        errorCode: 'AUTH_ERROR',
        message: 'Invalid API credential token',
        isTransient: false,
      };

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      const tempFinding = findings.find((f) => f.category === 'TEMPORARY_API_FAILURE');
      expect(tempFinding).toBeUndefined();
    });

    it('integration health gating: 3PL transient error does NOT get misclassified as ORDER_MISSING_AT_3PL', () => {
      const snapshot = createHealthySnapshot();
      delete snapshot.warehouse; // Warehouse representation not returned
      snapshot.shopify!.fulfillmentStatus = 'UNFULFILLED';
      snapshot.shopify!.createdAt = '2026-09-18T00:00:00.000Z'; // > 24h old

      // Simulate that 3PL call threw 503
      snapshot.warehouse = {
        id: '',
        orderNumber: '',
        status: 'RECEIVED',
        lineItems: [],
        createdAt: '',
        updatedAt: '',
        error: {
          provider: 'Generic3PL',
          statusCode: 503,
          errorCode: 'SERVICE_UNAVAILABLE',
          message: '3PL down',
          isTransient: true,
        },
      };

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('TEMPORARY_API_FAILURE');
      // Must NOT claim ORDER_MISSING_AT_3PL!
      expect(findings.some((f) => f.category === 'ORDER_MISSING_AT_3PL')).toBe(false);
    });
  });

  describe('4. Missing Shopify Tracking', () => {
    it('detects missing tracking with AUTO_RECOVER when deterministic matching passes cleanly', () => {
      const snapshot = createHealthySnapshot();
      snapshot.shopify!.fulfillmentStatus = 'UNFULFILLED';
      delete snapshot.shopify!.trackingNumber;

      // 3PL and ShipStation both agree on tracking
      snapshot.warehouse!.trackingNumber = 'TRK-FEDEX-9988';
      snapshot.warehouse!.status = 'PICKING';
      snapshot.shipstation!.trackingNumber = 'TRK-FEDEX-9988';

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('TRACKING_MISSING_IN_SHOPIFY');
      expect(findings[0].recoveryLevel).toBe('AUTO_RECOVER');
      expect(findings[0].evidence.disagreements.trackingNumber.expected).toBe('TRK-FEDEX-9988');
    });

    it('downgrades missing tracking from AUTO_RECOVER to REQUIRE_APPROVAL if match has conflicts', () => {
      const snapshot = createHealthySnapshot();
      snapshot.shopify!.fulfillmentStatus = 'UNFULFILLED';
      delete snapshot.shopify!.trackingNumber;

      snapshot.warehouse!.trackingNumber = 'TRK-FEDEX-9988';
      snapshot.warehouse!.status = 'PICKING';
      snapshot.shipstation!.trackingNumber = 'TRK-FEDEX-9988';
      // Introduce SKU conflict
      snapshot.warehouse!.lineItems = [{ sku: 'WRONG-SKU', quantity: 99 }];

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('TRACKING_MISSING_IN_SHOPIFY');
      expect(findings[0].recoveryLevel).toBe('REQUIRE_APPROVAL');
    });

    it('downgrades missing tracking to REQUIRE_APPROVAL if cross-system tracking conflict exists', () => {
      const snapshot = createHealthySnapshot();
      snapshot.shopify!.fulfillmentStatus = 'UNFULFILLED';
      delete snapshot.shopify!.trackingNumber;

      // 3PL has one tracking number, ShipStation has a different tracking number (conflict)
      snapshot.warehouse!.trackingNumber = 'TRK-3PL-111';
      snapshot.warehouse!.status = 'PICKING';
      snapshot.shipstation!.trackingNumber = 'TRK-SHIPSTATION-222';

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('TRACKING_MISSING_IN_SHOPIFY');
      expect(findings[0].recoveryLevel).toBe('REQUIRE_APPROVAL');
      expect(findings[0].evidence.conflictingIdentifiers.some((c) => c.includes('trackingNumberConflict'))).toBe(true);
    });
  });

  describe('5. 3PL Shipped But Shopify Unfulfilled', () => {
    it('detects SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY with REQUIRE_APPROVAL', () => {
      const snapshot = createHealthySnapshot();
      snapshot.shopify!.fulfillmentStatus = 'UNFULFILLED';
      delete snapshot.shopify!.trackingNumber;

      snapshot.warehouse!.status = 'SHIPPED';
      snapshot.warehouse!.trackingNumber = 'TRK-12345';

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY');
      expect(findings[0].recoveryLevel).toBe('REQUIRE_APPROVAL');
      expect(findings[0].evidence.disagreements.fulfillmentStatus.observed).toContain('Shopify=UNFULFILLED, 3PL=SHIPPED');
    });
  });

  describe('6. Order Missing At 3PL', () => {
    it('detects ORDER_MISSING_AT_3PL with REQUIRE_APPROVAL after fulfillment grace period', () => {
      const snapshot = createHealthySnapshot();
      delete snapshot.warehouse;
      snapshot.shopify!.fulfillmentStatus = 'UNFULFILLED';
      snapshot.shopify!.createdAt = '2026-09-19T06:00:00.000Z'; // 6h old (grace period is 1h)

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('ORDER_MISSING_AT_3PL');
      expect(findings[0].recoveryLevel).toBe('REQUIRE_APPROVAL');
    });

    it('does NOT flag missing at 3PL if order was created recently within grace period', () => {
      const snapshot = createHealthySnapshot();
      delete snapshot.warehouse;
      snapshot.shopify!.fulfillmentStatus = 'UNFULFILLED';
      snapshot.shopify!.createdAt = '2026-09-19T11:45:00.000Z'; // 15 mins old (grace period is 1h)

      const findings = reconcileOrder(snapshot, {
        evaluationTime: baseEvaluationTime,
        fulfillmentGracePeriodMs: 3_600_000,
      });
      expect(findings).toHaveLength(0);
    });
  });

  describe('7. Stuck Order Detection', () => {
    it('detects STUCK_ORDER with AUTO_INVESTIGATE when operational state exceeds 24h threshold', () => {
      const snapshot = createHealthySnapshot();
      snapshot.warehouse!.status = 'PICKING';
      snapshot.warehouse!.updatedAt = '2026-09-17T10:00:00.000Z'; // ~50 hours old

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      const stuck = findings.find((f) => f.category === 'STUCK_ORDER');
      expect(stuck).toBeDefined();
      expect(stuck?.recoveryLevel).toBe('AUTO_INVESTIGATE');
      expect(stuck?.summary).toContain('PICKING');
    });

    it('does not trigger stuck order if within threshold', () => {
      const snapshot = createHealthySnapshot();
      snapshot.warehouse!.status = 'PICKING';
      snapshot.warehouse!.updatedAt = '2026-09-19T10:00:00.000Z'; // 2 hours old

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      const stuck = findings.find((f) => f.category === 'STUCK_ORDER');
      expect(stuck).toBeUndefined();
    });
  });

  describe('8. Inventory Mismatch', () => {
    it('detects INVENTORY_MISMATCH with REQUIRE_APPROVAL when quantities disagree', () => {
      const snapshot = createHealthySnapshot();
      snapshot.inventory = [
        { sku: 'SKU-A', shopifyQuantity: 50, warehouseQuantity: 42 },
      ];

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      const invFinding = findings.find((f) => f.category === 'INVENTORY_MISMATCH');
      expect(invFinding).toBeDefined();
      expect(invFinding?.recoveryLevel).toBe('REQUIRE_APPROVAL');
      expect(invFinding?.summary).toContain('Shopify: 50, 3PL: 42');
    });
  });

  describe('9. Duplicate Risk (BLOCK)', () => {
    it('detects DUPLICATE_RISK with BLOCK when multiple warehouse candidate orders exist', () => {
      const snapshot = createHealthySnapshot();
      snapshot.warehouse!.candidateOrders = [
        { id: 'cand-1', orderNumber: 'ORD-1001', status: 'RECEIVED' },
        { id: 'cand-2', orderNumber: 'ORD-1001', status: 'PICKING' },
      ];

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('DUPLICATE_RISK');
      expect(findings[0].recoveryLevel).toBe('BLOCK');
      expect(findings[0].evidence.blockingReason).toBeDefined();
    });

    it('detects DUPLICATE_RISK when simulator DUPLICATE_ORDER error occurs', () => {
      const snapshot = createHealthySnapshot();
      snapshot.shopify!.error = {
        provider: 'Shopify',
        statusCode: 409,
        errorCode: 'DUPLICATE_ORDER',
        message: 'Order reference duplicate found',
        isTransient: false,
      };

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('DUPLICATE_RISK');
      expect(findings[0].recoveryLevel).toBe('BLOCK');
    });
  });

  describe('10. Invalid Order Data (BLOCK)', () => {
    it('detects INVALID_ORDER_DATA with BLOCK when address is invalid', () => {
      const snapshot = createHealthySnapshot();
      snapshot.shopify!.addressValid = false;

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('INVALID_ORDER_DATA');
      expect(findings[0].recoveryLevel).toBe('BLOCK');
    });

    it('detects INVALID_ORDER_DATA with BLOCK when SKU is unknown/invalid', () => {
      const snapshot = createHealthySnapshot();
      snapshot.shopify!.lineItems = [{ sku: 'INVALID_SKU', quantity: 1 }];

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('INVALID_ORDER_DATA');
      expect(findings[0].recoveryLevel).toBe('BLOCK');
    });
  });

  describe('11. Rule Precedence (Safety First)', () => {
    it('DUPLICATE_RISK suppresses lower priority missing tracking or shipped-unfulfilled rules', () => {
      const snapshot = createHealthySnapshot();
      // Set conditions for shipped-unfulfilled AND duplicate risk
      snapshot.shopify!.fulfillmentStatus = 'UNFULFILLED';
      snapshot.warehouse!.status = 'SHIPPED';
      snapshot.warehouse!.candidateOrders = [
        { id: 'cand-1', orderNumber: 'ORD-1001', status: 'SHIPPED' },
        { id: 'cand-2', orderNumber: 'ORD-1001', status: 'SHIPPED' },
      ];

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('DUPLICATE_RISK');
      expect(findings[0].recoveryLevel).toBe('BLOCK');
      // Lower precedence rule was suppressed
      expect(findings.some((f) => f.category === 'SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY')).toBe(false);
    });

    it('INVALID_ORDER_DATA suppresses auto-recoverable missing tracking', () => {
      const snapshot = createHealthySnapshot();
      snapshot.shopify!.addressValid = false;
      snapshot.shopify!.fulfillmentStatus = 'UNFULFILLED';
      delete snapshot.shopify!.trackingNumber;
      snapshot.warehouse!.trackingNumber = 'TRK-VALID';

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('INVALID_ORDER_DATA');
      expect(findings[0].recoveryLevel).toBe('BLOCK');
      expect(findings.some((f) => f.category === 'TRACKING_MISSING_IN_SHOPIFY')).toBe(false);
    });

    it('TEMPORARY_API_FAILURE suppresses missing at 3PL', () => {
      const snapshot = createHealthySnapshot();
      delete snapshot.warehouse;
      snapshot.shopify!.fulfillmentStatus = 'UNFULFILLED';
      snapshot.shopify!.createdAt = '2026-09-18T00:00:00.000Z';
      snapshot.shopify!.error = {
        provider: 'Shopify',
        statusCode: 503,
        errorCode: 'TEMPORARY_FAILURE',
        message: 'Shopify outage',
        isTransient: true,
      };

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('TEMPORARY_API_FAILURE');
      expect(findings.some((f) => f.category === 'ORDER_MISSING_AT_3PL')).toBe(false);
    });
  });

  describe('12. Determinism & Explanations', () => {
    it('always produces identical findings given the same input snapshot and evaluation time', () => {
      const snapshot = createHealthySnapshot();
      snapshot.shopify!.fulfillmentStatus = 'UNFULFILLED';
      delete snapshot.shopify!.trackingNumber;
      snapshot.warehouse!.trackingNumber = 'TRK-REPEATABLE-123';
      snapshot.warehouse!.status = 'PICKING';

      const runA = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      const runB = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });

      expect(runA).toEqual(runB);
      expect(runA[0].evidence.evaluatedAt).toBe(baseEvaluationTime);
    });

    it('does not include passwords, credentials, tokens, or raw authorization headers in evidence', () => {
      const snapshot = createHealthySnapshot();
      snapshot.shopify!.fulfillmentStatus = 'UNFULFILLED';
      delete snapshot.shopify!.trackingNumber;
      snapshot.warehouse!.trackingNumber = 'TRK-SAFE';
      snapshot.warehouse!.status = 'PICKING';

      const findings = reconcileOrder(snapshot, { evaluationTime: baseEvaluationTime });
      const serialized = JSON.stringify(findings[0]);

      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('Authorization');
      expect(serialized).not.toContain('Bearer');
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('token');
    });
  });
});
