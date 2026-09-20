import {
  DeterministicMatcher,
  ReconciliationRules,
  NormalizedOrderSnapshot,
} from '../src';

describe('Cross-System Reconciliation: Real Shopify & ShipStation V2', () => {
  const nowIso = '2026-09-20T12:00:00.000Z';

  describe('1. Deterministic Cross-System Matching', () => {
    it('returns MATCH when ShipStation orderNumber matches Shopify orderNumber', () => {
      const snapshot: NormalizedOrderSnapshot = {
        organizationId: 'org-1',
        orderNumber: '1042',
        shopify: {
          id: 'gid://shopify/Order/1042',
          orderNumber: '1042',
          fulfillmentStatus: 'UNFULFILLED',
          lineItems: [{ sku: 'PROD-A', quantity: 2 }],
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-20T08:00:00Z',
        },
        shipstation: {
          id: 'ss-9001',
          orderNumber: '1042',
          carrier: 'usps',
          trackingNumber: '9400111899562537624123',
          status: 'LABEL_CREATED',
          createdAt: '2026-09-20T09:00:00Z',
          updatedAt: '2026-09-20T09:30:00Z',
        },
      };

      const matchResult = DeterministicMatcher.matchShopifyToShipping(snapshot);
      expect(matchResult.status).toBe('MATCH');
      expect(matchResult.matchedIdentifiers).toContain('orderNumber:1042');
      expect(matchResult.conflictingIdentifiers).toHaveLength(0);
      expect(matchResult.candidateCount).toBe(1);
    });

    it('returns NO_MATCH when orders are disjoint', () => {
      const snapshot: NormalizedOrderSnapshot = {
        organizationId: 'org-1',
        orderNumber: '1042',
        shopify: {
          id: 'gid://shopify/Order/1042',
          orderNumber: '1042',
          fulfillmentStatus: 'UNFULFILLED',
          lineItems: [{ sku: 'PROD-A', quantity: 2 }],
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-20T08:00:00Z',
        },
      };

      const matchResult = DeterministicMatcher.matchShopifyToShipping(snapshot);
      expect(matchResult.status).toBe('NO_MATCH');
      expect(matchResult.candidateCount).toBe(0);
    });

    it('returns AMBIGUOUS when multiple candidate shipments exist in ShipStation without conflicting tracking', () => {
      const snapshot: NormalizedOrderSnapshot = {
        organizationId: 'org-1',
        orderNumber: '1042',
        shopify: {
          id: 'gid://shopify/Order/1042',
          orderNumber: '1042',
          fulfillmentStatus: 'UNFULFILLED',
          lineItems: [{ sku: 'PROD-A', quantity: 2 }],
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-20T08:00:00Z',
        },
        shipstation: {
          id: 'ss-9001',
          orderNumber: '1042',
          carrier: 'usps',
          status: 'LABEL_CREATED',
          candidateShipments: [
            {
              id: 'ss-9001',
              orderNumber: '1042',
              carrier: 'usps',
              status: 'LABEL_CREATED',
            },
            {
              id: 'ss-9002',
              orderNumber: '1042',
              carrier: 'fedex',
              status: 'LABEL_CREATED',
            },
          ],
          createdAt: '2026-09-20T09:00:00Z',
          updatedAt: '2026-09-20T09:30:00Z',
        },
      };

      const matchResult = DeterministicMatcher.matchShopifyToShipping(snapshot);
      expect(matchResult.status).toBe('AMBIGUOUS');
      expect(matchResult.candidateCount).toBe(2);
    });

    it('returns CONFLICT when candidates have conflicting tracking numbers', () => {
      const snapshot: NormalizedOrderSnapshot = {
        organizationId: 'org-1',
        orderNumber: '1042',
        shopify: {
          id: 'gid://shopify/Order/1042',
          orderNumber: '1042',
          fulfillmentStatus: 'UNFULFILLED',
          lineItems: [{ sku: 'PROD-A', quantity: 2 }],
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-20T08:00:00Z',
        },
        shipstation: {
          id: 'ss-9001',
          orderNumber: '1042',
          carrier: 'usps',
          trackingNumber: '9400111899562537624123',
          status: 'LABEL_CREATED',
          candidateShipments: [
            {
              id: 'ss-9001',
              orderNumber: '1042',
              trackingNumber: '9400111899562537624123',
              carrier: 'usps',
              status: 'LABEL_CREATED',
            },
            {
              id: 'ss-9002',
              orderNumber: '1042',
              trackingNumber: '9400111899562537629999',
              carrier: 'fedex',
              status: 'LABEL_CREATED',
            },
          ],
          createdAt: '2026-09-20T09:00:00Z',
          updatedAt: '2026-09-20T09:30:00Z',
        },
      };

      const matchResult = DeterministicMatcher.matchShopifyToShipping(snapshot);
      expect(matchResult.status).toBe('CONFLICT');
      expect(matchResult.candidateCount).toBe(2);
      expect(matchResult.conflictingIdentifiers[0]).toContain('trackingConflict');
    });

    it('returns CONFLICT when split shipment has multiple active tracking labels', () => {
      const snapshot: NormalizedOrderSnapshot = {
        organizationId: 'org-1',
        orderNumber: '1042',
        shopify: {
          id: 'gid://shopify/Order/1042',
          orderNumber: '1042',
          fulfillmentStatus: 'UNFULFILLED',
          lineItems: [{ sku: 'PROD-A', quantity: 2 }],
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-20T08:00:00Z',
        },
        shipstation: {
          id: 'ss-9001',
          orderNumber: '1042',
          carrier: 'usps',
          status: 'LABEL_CREATED',
          labels: [
            {
              id: 'lbl-1',
              shipmentId: 'ss-9001',
              trackingNumber: '9400111899562537624111',
              status: 'completed',
              voided: false,
              createdAt: '2026-09-20T09:00:00Z',
            },
            {
              id: 'lbl-2',
              shipmentId: 'ss-9001',
              trackingNumber: '9400111899562537624222',
              status: 'completed',
              voided: false,
              createdAt: '2026-09-20T09:05:00Z',
            },
          ],
          createdAt: '2026-09-20T09:00:00Z',
          updatedAt: '2026-09-20T09:30:00Z',
        },
      };

      const matchResult = DeterministicMatcher.matchShopifyToShipping(snapshot);
      expect(matchResult.status).toBe('CONFLICT');
      expect(matchResult.conflictingIdentifiers[0]).toContain('splitShipmentTrackingConflict');
    });

    it('returns CONFLICT when tracking number disagrees with 3PL warehouse tracking', () => {
      const snapshot: NormalizedOrderSnapshot = {
        organizationId: 'org-1',
        orderNumber: '1042',
        shopify: {
          id: 'gid://shopify/Order/1042',
          orderNumber: '1042',
          fulfillmentStatus: 'UNFULFILLED',
          lineItems: [{ sku: 'PROD-A', quantity: 2 }],
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-20T08:00:00Z',
        },
        warehouse: {
          id: 'wh-100',
          orderNumber: '1042',
          status: 'SHIPPED',
          trackingNumber: '1Z9999999999999999', // UPS tracking
          lineItems: [{ sku: 'PROD-A', quantity: 2 }],
          createdAt: '2026-09-20T08:30:00Z',
          updatedAt: '2026-09-20T09:00:00Z',
        },
        shipstation: {
          id: 'ss-9001',
          orderNumber: '1042',
          carrier: 'usps',
          trackingNumber: '9400111899562537624123', // USPS tracking
          status: 'LABEL_CREATED',
          createdAt: '2026-09-20T09:00:00Z',
          updatedAt: '2026-09-20T09:30:00Z',
        },
      };

      const matchResult = DeterministicMatcher.matchShopifyToShipping(snapshot);
      expect(matchResult.status).toBe('CONFLICT');
      expect(matchResult.conflictingIdentifiers[0]).toContain('trackingNumberConflict');
    });
  });

  describe('2. Reconciliation Invariant Enforcement', () => {
    it('detects TRACKING_MISSING_IN_SHOPIFY with AUTO_RECOVER when ShipStation has unique active non-voided label', () => {
      const snapshot: NormalizedOrderSnapshot = {
        organizationId: 'org-1',
        orderNumber: '1042',
        shopify: {
          id: 'gid://shopify/Order/1042',
          orderNumber: '1042',
          fulfillmentStatus: 'UNFULFILLED',
          lineItems: [{ sku: 'PROD-A', quantity: 2 }],
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-20T08:00:00Z',
        },
        shipstation: {
          id: 'ss-9001',
          orderNumber: '1042',
          carrier: 'usps',
          status: 'LABEL_CREATED',
          labels: [
            {
              id: 'lbl-100',
              shipmentId: 'ss-9001',
              trackingNumber: '9400111899562537624123',
              status: 'completed',
              voided: false,
              createdAt: '2026-09-20T09:00:00Z',
            },
          ],
          createdAt: '2026-09-20T09:00:00Z',
          updatedAt: '2026-09-20T09:30:00Z',
        },
      };

      const finding = ReconciliationRules.evaluateMissingTracking(snapshot, nowIso);
      expect(finding).not.toBeNull();
      expect(finding?.category).toBe('TRACKING_MISSING_IN_SHOPIFY');
      expect(finding?.recoveryLevel).toBe('AUTO_RECOVER');
      expect(finding?.evidence.systemsCompared).toEqual(['Shopify', 'ShipStation']);
      expect(finding?.evidence.disagreements.trackingNumber).toEqual({
        expected: '9400111899562537624123',
        observed: null,
      });
      expect(finding?.evidence.details?.labelCandidateCount).toBe(1);
      expect(finding?.evidence.details?.isAutoRecoverEligible).toBe(true);
    });

    it('handles voided label alongside active label without compromising active tracking', () => {
      const snapshot: NormalizedOrderSnapshot = {
        organizationId: 'org-1',
        orderNumber: '1042',
        shopify: {
          id: 'gid://shopify/Order/1042',
          orderNumber: '1042',
          fulfillmentStatus: 'UNFULFILLED',
          lineItems: [{ sku: 'PROD-A', quantity: 2 }],
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-20T08:00:00Z',
        },
        shipstation: {
          id: 'ss-9001',
          orderNumber: '1042',
          carrier: 'usps',
          status: 'LABEL_CREATED',
          labels: [
            {
              id: 'lbl-void',
              shipmentId: 'ss-9001',
              trackingNumber: '9400111899562537624000',
              status: 'voided',
              voided: true,
              createdAt: '2026-09-20T08:30:00Z',
            },
            {
              id: 'lbl-active',
              shipmentId: 'ss-9001',
              trackingNumber: '9400111899562537624999',
              status: 'completed',
              voided: false,
              createdAt: '2026-09-20T09:00:00Z',
            },
          ],
          createdAt: '2026-09-20T09:00:00Z',
          updatedAt: '2026-09-20T09:30:00Z',
        },
      };

      const finding = ReconciliationRules.evaluateMissingTracking(snapshot, nowIso);
      expect(finding).not.toBeNull();
      expect(finding?.category).toBe('TRACKING_MISSING_IN_SHOPIFY');
      // Presence of a voided label triggers caution (hasVoidedLabels=true), requiring approval
      expect(finding?.recoveryLevel).toBe('REQUIRE_APPROVAL');
      expect(finding?.evidence.details?.externalTracking).toBe('9400111899562537624999');
      expect(finding?.evidence.details?.hasVoidedLabels).toBe(true);
    });

    it('CRITICAL: voided label alone must NOT supply active tracking evidence', () => {
      const snapshot: NormalizedOrderSnapshot = {
        organizationId: 'org-1',
        orderNumber: '1042',
        shopify: {
          id: 'gid://shopify/Order/1042',
          orderNumber: '1042',
          fulfillmentStatus: 'UNFULFILLED',
          lineItems: [{ sku: 'PROD-A', quantity: 2 }],
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-20T08:00:00Z',
        },
        shipstation: {
          id: 'ss-9001',
          orderNumber: '1042',
          carrier: 'usps',
          status: 'LABEL_CREATED',
          labels: [
            {
              id: 'lbl-void-only',
              shipmentId: 'ss-9001',
              trackingNumber: '9400111899562537624000',
              status: 'voided',
              voided: true,
              createdAt: '2026-09-20T08:30:00Z',
            },
          ],
          createdAt: '2026-09-20T09:00:00Z',
          updatedAt: '2026-09-20T09:30:00Z',
        },
      };

      const finding = ReconciliationRules.evaluateMissingTracking(snapshot, nowIso);
      // Voided label cannot supply active tracking, so no missing tracking finding is produced
      expect(finding).toBeNull();
    });

    it('requires approval for split shipment with multiple active tracking labels', () => {
      const snapshot: NormalizedOrderSnapshot = {
        organizationId: 'org-1',
        orderNumber: '1042',
        shopify: {
          id: 'gid://shopify/Order/1042',
          orderNumber: '1042',
          fulfillmentStatus: 'UNFULFILLED',
          lineItems: [{ sku: 'PROD-A', quantity: 2 }],
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-20T08:00:00Z',
        },
        shipstation: {
          id: 'ss-9001',
          orderNumber: '1042',
          carrier: 'usps',
          status: 'LABEL_CREATED',
          labels: [
            {
              id: 'lbl-1',
              shipmentId: 'ss-9001',
              trackingNumber: '9400111899562537624111',
              status: 'completed',
              voided: false,
              createdAt: '2026-09-20T09:00:00Z',
            },
            {
              id: 'lbl-2',
              shipmentId: 'ss-9001',
              trackingNumber: '9400111899562537624222',
              status: 'completed',
              voided: false,
              createdAt: '2026-09-20T09:05:00Z',
            },
          ],
          createdAt: '2026-09-20T09:00:00Z',
          updatedAt: '2026-09-20T09:30:00Z',
        },
      };

      const finding = ReconciliationRules.evaluateMissingTracking(snapshot, nowIso);
      expect(finding).not.toBeNull();
      expect(finding?.category).toBe('TRACKING_MISSING_IN_SHOPIFY');
      // Split shipment MUST NOT auto-recover!
      expect(finding?.recoveryLevel).toBe('REQUIRE_APPROVAL');
      expect(finding?.evidence.details?.isSplitShipment).toBe(true);
      expect(finding?.evidence.details?.isAutoRecoverEligible).toBe(false);
    });

    it('blocks automated recovery with DUPLICATE_RISK when multiple shipping candidates exist', () => {
      const snapshot: NormalizedOrderSnapshot = {
        organizationId: 'org-1',
        orderNumber: '1042',
        shopify: {
          id: 'gid://shopify/Order/1042',
          orderNumber: '1042',
          fulfillmentStatus: 'UNFULFILLED',
          lineItems: [{ sku: 'PROD-A', quantity: 2 }],
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-20T08:00:00Z',
        },
        shipstation: {
          id: 'ss-9001',
          orderNumber: '1042',
          carrier: 'usps',
          trackingNumber: '9400111899562537624123',
          status: 'LABEL_CREATED',
          candidateShipments: [
            {
              id: 'ss-9001',
              orderNumber: '1042',
              trackingNumber: '9400111899562537624123',
              carrier: 'usps',
              status: 'LABEL_CREATED',
            },
            {
              id: 'ss-9002',
              orderNumber: '1042',
              trackingNumber: '9400111899562537629999',
              carrier: 'fedex',
              status: 'LABEL_CREATED',
            },
          ],
          createdAt: '2026-09-20T09:00:00Z',
          updatedAt: '2026-09-20T09:30:00Z',
        },
      };

      const finding = ReconciliationRules.evaluateDuplicateRisk(snapshot, nowIso);
      expect(finding).not.toBeNull();
      expect(finding?.category).toBe('DUPLICATE_RISK');
      expect(finding?.recoveryLevel).toBe('BLOCK');
      expect(finding?.evidence.candidateCount).toBe(2);
    });

    it('CRITICAL: does NOT trigger SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY for ShipStation label_created', () => {
      const snapshot: NormalizedOrderSnapshot = {
        organizationId: 'org-1',
        orderNumber: '1042',
        shopify: {
          id: 'gid://shopify/Order/1042',
          orderNumber: '1042',
          fulfillmentStatus: 'UNFULFILLED',
          lineItems: [{ sku: 'PROD-A', quantity: 2 }],
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-20T08:00:00Z',
        },
        shipstation: {
          id: 'ss-9001',
          orderNumber: '1042',
          carrier: 'usps',
          trackingNumber: '9400111899562537624123',
          status: 'LABEL_CREATED',
          createdAt: '2026-09-20T09:00:00Z',
          updatedAt: '2026-09-20T09:30:00Z',
        },
      };

      const finding = ReconciliationRules.evaluateShippedUnfulfilled(snapshot, nowIso);
      expect(finding).toBeNull();
    });

    it('CRITICAL: does NOT trigger ORDER_MISSING_AT_3PL when ShipStation is present without 3PL warehouse', () => {
      const snapshot: NormalizedOrderSnapshot = {
        organizationId: 'org-1',
        orderNumber: '1042',
        shopify: {
          id: 'gid://shopify/Order/1042',
          orderNumber: '1042',
          fulfillmentStatus: 'UNFULFILLED',
          lineItems: [{ sku: 'PROD-A', quantity: 2 }],
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-20T08:00:00Z',
        },
        shipstation: {
          id: 'ss-9001',
          orderNumber: '1042',
          carrier: 'usps',
          trackingNumber: '9400111899562537624123',
          status: 'LABEL_CREATED',
          createdAt: '2026-09-20T09:00:00Z',
          updatedAt: '2026-09-20T09:30:00Z',
        },
      };

      const finding = ReconciliationRules.evaluateOrderMissingAt3PL(snapshot, nowIso);
      expect(finding).toBeNull();
    });
  });
});
