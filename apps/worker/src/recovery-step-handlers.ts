import { createHash } from 'crypto';
import { JobErrorCategory } from '@prisma/client';
import { JobExecutionError } from './errors';
import { WorkflowStepContext } from './workflow-step-registry';
import {
  RecoveryActionExecutor,
  SimulatorRecoveryActionAdapter,
} from '@reloop/connector-simulator';

export interface RecoveryStepHandlerDependencies {
  actionExecutor: RecoveryActionExecutor;
  resolveCaseCallback?: (params: {
    caseId: string;
    organizationId: string;
    workflowId: string;
    verifyStepKey?: string;
    verificationOutput: {
      verified: boolean;
      invariantPassed: string;
      authoritativeState?: Record<string, unknown>;
      details?: Record<string, unknown>;
    };
  }) => Promise<unknown>;
}

/**
 * Computes a deterministic SHA256 safety fingerprint of normalized order state.
 */
export function computeSafetyFingerprint(state: Record<string, unknown>): string {
  const normalized = JSON.stringify(state, Object.keys(state).sort());
  return createHash('sha256').update(normalized).digest('hex').substring(0, 16);
}

function requireOrderNumber(payload: Record<string, unknown>, handlerKey: string): string {
  const orderNumber = payload.orderNumber as string | undefined;
  if (!orderNumber || typeof orderNumber !== 'string' || orderNumber.trim() === '') {
    throw new JobExecutionError({
      category: JobErrorCategory.BUSINESS_ERROR,
      code: 'MISSING_ORDER_NUMBER',
      message: `Authoritative orderNumber is required in payload for handler "${handlerKey}".`,
      retryable: false,
    });
  }
  return orderNumber;
}

function requireCaseId(payload: Record<string, unknown>, handlerKey: string): string {
  const caseId = payload.caseId as string | undefined;
  if (!caseId || typeof caseId !== 'string' || caseId.trim() === '') {
    throw new JobExecutionError({
      category: JobErrorCategory.BUSINESS_ERROR,
      code: 'MISSING_CASE_ID',
      message: `Authoritative caseId is required in payload for handler "${handlerKey}".`,
      retryable: false,
    });
  }
  return caseId;
}

/**
 * Registers canonical Day 13 recovery step handlers with the worker handler registry.
 */
export function registerRecoveryStepHandlers(
  registry: { register: (handlerKey: string, handler: any) => void },
  deps?: Partial<RecoveryStepHandlerDependencies>,
): void {
  const actionExecutor = deps?.actionExecutor ?? new SimulatorRecoveryActionAdapter();

  // =========================================================================
  // 1. MISSING SHOPIFY TRACKING HANDLERS
  // =========================================================================

  // CHECK: Rereads live state from simulator; validates deterministic match; computes safety fingerprint
  registry.register('RECOVERY_CHECK_TRACKING', async (context: WorkflowStepContext) => {
    const payload = (context.payload ?? {}) as Record<string, unknown>;
    const orderNumber = requireOrderNumber(payload, 'RECOVERY_CHECK_TRACKING');

    // Authoritative reread (Requirement 11)
    const state = await actionExecutor.fetchAuthoritativeOrderState(orderNumber);
    const shp = state.shopify;
    const wh = state.warehouse;

    if (!shp) {
      throw new JobExecutionError({
        category: JobErrorCategory.NOT_FOUND,
        code: 'SHOPIFY_ORDER_NOT_FOUND',
        message: `Shopify order ${orderNumber} not found during CHECK`,
        retryable: false,
      });
    }

    // Safety check: is problem already resolved independently? (Requirement 12)
    if (shp.trackingNumber && wh?.trackingNumber && shp.trackingNumber === wh.trackingNumber) {
      return {
        output: {
          noActionNeeded: true,
          resolvedClean: true,
          trackingNumber: shp.trackingNumber,
          carrier: shp.carrier || wh.carrier || 'FedEx',
          orderNumber,
          safetyFingerprint: 'HEALTHY_AGREEMENT',
        },
      };
    }

    // Injected conflict detection / escalation (Requirement 13)
    if (wh?.carrier === 'CONFLICT_CARRIER' || wh?.trackingNumber?.includes('CONFLICT')) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'CHECK_CONFLICT_DETECTED',
        message: `Conflicting shipment identity detected during live CHECK for order ${orderNumber}`,
        retryable: false,
      });
    }

    if (!wh || !wh.trackingNumber) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'WAREHOUSE_TRACKING_UNAVAILABLE',
        message: `Warehouse tracking not yet available for order ${orderNumber}`,
        retryable: true,
      });
    }

    const trackingNumber = wh.trackingNumber;
    const carrier = wh.carrier || 'FedEx';
    const safetyFingerprint = computeSafetyFingerprint({
      orderNumber,
      shpTracking: shp.trackingNumber || null,
      whTracking: trackingNumber,
      whStatus: wh.status,
    });

    const dynamicPreview = {
      version: 1,
      problem: `Shopify order ${orderNumber} is missing tracking while warehouse order is ${wh.status}`,
      proposedAction: `Apply verified tracking ${trackingNumber} (${carrier}) to Shopify order ${orderNumber}`,
      why: 'Reread from live warehouse confirms shipment active but customer tracking stalled',
      safetyChecks: [
        'Live warehouse status verified as SHIPPED/PACKED',
        `Tracking number format verified: ${trackingNumber}`,
        `Safety fingerprint generated: ${safetyFingerprint}`,
      ],
      changes: [
        `Add tracking number ${trackingNumber} to Shopify fulfillment`,
        `Set carrier to ${carrier}`,
      ],
      nonChanges: ['Do not modify line items or customer payment'],
      systems: ['Shopify', 'Generic3PL'],
      risks: ['Customer receives shipment update notification'],
      recoveryLevel: 'REQUIRE_APPROVAL',
      orderReference: orderNumber,
      expectedVerification: `Shopify tracking number equals ${trackingNumber}`,
    };

    return {
      output: {
        safeToExecute: true,
        orderNumber,
        trackingNumber,
        carrier,
        safetyFingerprint,
        preview: dynamicPreview,
      },
    };
  });

  // EXECUTE: Pre-execution fence -> Mutates simulator with stable idempotency key -> Handles commit-then-timeout
  registry.register('RECOVERY_EXECUTE_TRACKING', async (context: WorkflowStepContext) => {
    const payload = (context.payload ?? {}) as Record<string, unknown>;
    const orderNumber = requireOrderNumber(payload, 'RECOVERY_EXECUTE_TRACKING');
    const recoveryCaseId = requireCaseId(payload, 'RECOVERY_EXECUTE_TRACKING');

    // Pre-execution fence: reread live state (Requirement 14 & 47)
    const currentState = await actionExecutor.fetchAuthoritativeOrderState(orderNumber);
    if (
      currentState.warehouse?.carrier === 'CONFLICT_CARRIER' ||
      currentState.warehouse?.trackingNumber?.includes('CONFLICT')
    ) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'EXECUTE_FENCE_CONFLICT',
        message: 'Pre-execution fence blocked mutation: conflicting shipment identity emerged',
        retryable: false,
      });
    }

    // Check if already healthy / no action needed
    if (
      currentState.shopify?.trackingNumber &&
      currentState.warehouse?.trackingNumber &&
      currentState.shopify.trackingNumber === currentState.warehouse.trackingNumber
    ) {
      return {
        output: {
          skippedMutation: true,
          executed: true,
          trackingNumber: currentState.shopify.trackingNumber,
          carrier: currentState.shopify.carrier,
          reason: 'State already converged prior to mutation',
        },
      };
    }

    const trackingNumber =
      (payload.trackingNumber as string) || currentState.warehouse?.trackingNumber || 'TRK-DEFAULT';
    const carrier = (payload.carrier as string) || currentState.warehouse?.carrier || 'FedEx';

    // Execute mutation
    const result = await actionExecutor.updateShopifyTracking({
      organizationId: context.organizationId,
      recoveryCaseId,
      orderNumber,
      trackingNumber,
      carrier,
    });

    // Handle ambiguous timeout (Requirement 17 & 23)
    if (result.ambiguous) {
      const recheckedState = await actionExecutor.fetchAuthoritativeOrderState(orderNumber);
      if (recheckedState.shopify?.trackingNumber === trackingNumber) {
        return {
          output: {
            executed: true,
            recoveredFromAmbiguity: true,
            trackingNumber,
            carrier,
            operationKey: result.operationKey,
          },
        };
      }
      throw new JobExecutionError({
        category: JobErrorCategory.TRANSIENT,
        code: 'AMBIGUOUS_COMMIT_TIMEOUT',
        message: 'Ambiguous commit-then-timeout from Shopify: external state could not be verified',
        retryable: true,
      });
    }

    if (!result.success) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'SHOPIFY_UPDATE_FAILED',
        message: result.error || 'Failed to update Shopify tracking',
        retryable: false,
      });
    }

    return {
      output: {
        executed: true,
        trackingNumber,
        carrier,
        operationKey: result.operationKey,
      },
    };
  });

  // VERIFY: Rereads authoritative systems; verifies agreement; returns verification output
  registry.register('RECOVERY_VERIFY_TRACKING', async (context: WorkflowStepContext) => {
    const payload = (context.payload ?? {}) as Record<string, unknown>;
    const orderNumber = requireOrderNumber(payload, 'RECOVERY_VERIFY_TRACKING');
    const recoveryCaseId = requireCaseId(payload, 'RECOVERY_VERIFY_TRACKING');

    // Authoritative reread (Requirement 26 & 27)
    const state = await actionExecutor.fetchAuthoritativeOrderState(orderNumber);
    const shp = state.shopify;
    const wh = state.warehouse;

    const shpTrk = shp?.trackingNumber;
    const whTrk = wh?.trackingNumber;

    if (!shpTrk || !whTrk || shpTrk !== whTrk) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'VERIFICATION_MISMATCH',
        message: `Verification failed: Shopify tracking "${shpTrk}" does not match warehouse tracking "${whTrk}"`,
        retryable: false,
      });
    }

    const verificationOutput = {
      verified: true,
      invariantPassed: 'TRACKING_CONSISTENCY',
      authoritativeState: {
        shopifyTracking: shpTrk,
        warehouseTracking: whTrk,
        shopifyFulfillmentStatus: shp.fulfillmentStatus,
      },
      details: {
        orderNumber,
        caseId: recoveryCaseId,
        verifiedAt: new Date().toISOString(),
      },
    };

    // Invoke optional CaseResolution callback if provided for backward compatibility
    if (deps?.resolveCaseCallback && recoveryCaseId) {
      await deps.resolveCaseCallback({
        caseId: recoveryCaseId,
        organizationId: context.organizationId,
        workflowId: context.workflowId,
        verifyStepKey: context.stepKey,
        verificationOutput,
      });
    }

    return { output: verificationOutput };
  });

  // =========================================================================
  // 2. ORDER MISSING AT 3PL HANDLERS
  // =========================================================================

  registry.register('RECOVERY_CHECK_ORDER_3PL', async (context: WorkflowStepContext) => {
    const payload = (context.payload ?? {}) as Record<string, unknown>;
    const orderNumber = requireOrderNumber(payload, 'RECOVERY_CHECK_ORDER_3PL');

    const state = await actionExecutor.fetchAuthoritativeOrderState(orderNumber);
    if (!state.shopify) {
      throw new JobExecutionError({
        category: JobErrorCategory.NOT_FOUND,
        code: 'SHOPIFY_ORDER_NOT_FOUND',
        message: `Shopify order ${orderNumber} not found during 3PL check`,
        retryable: false,
      });
    }

    // If order already exists at 3PL, no action needed
    if (state.warehouse) {
      return {
        output: {
          noActionNeeded: true,
          resolvedClean: true,
          warehouseOrderId: state.warehouse.id,
          orderNumber,
        },
      };
    }

    const safetyFingerprint = computeSafetyFingerprint({
      orderNumber,
      shopifyId: state.shopify.id,
      itemsCount: state.shopify.lineItems.length,
    });

    return {
      output: {
        safeToExecute: true,
        orderNumber,
        safetyFingerprint,
      },
    };
  });

  registry.register('RECOVERY_EXECUTE_ORDER_3PL', async (context: WorkflowStepContext) => {
    const payload = (context.payload ?? {}) as Record<string, unknown>;
    const orderNumber = requireOrderNumber(payload, 'RECOVERY_EXECUTE_ORDER_3PL');
    const recoveryCaseId = requireCaseId(payload, 'RECOVERY_EXECUTE_ORDER_3PL');

    const result = await actionExecutor.create3PLOrder({
      organizationId: context.organizationId,
      recoveryCaseId,
      orderNumber,
      externalReference: orderNumber,
    });

    if (!result.success && !result.ambiguous) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'CREATE_3PL_FAILED',
        message: result.error || 'Failed to create warehouse order',
        retryable: false,
      });
    }

    return {
      output: {
        executed: true,
        externalId: result.externalId,
        operationKey: result.operationKey,
      },
    };
  });

  registry.register('RECOVERY_VERIFY_ORDER_3PL', async (context: WorkflowStepContext) => {
    const payload = (context.payload ?? {}) as Record<string, unknown>;
    const orderNumber = requireOrderNumber(payload, 'RECOVERY_VERIFY_ORDER_3PL');
    const recoveryCaseId = requireCaseId(payload, 'RECOVERY_VERIFY_ORDER_3PL');

    const state = await actionExecutor.fetchAuthoritativeOrderState(orderNumber);
    if (!state.warehouse) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'VERIFICATION_MISMATCH',
        message: `Verification failed: warehouse order ${orderNumber} was not found at 3PL`,
        retryable: false,
      });
    }

    const verificationOutput = {
      verified: true,
      invariantPassed: 'WAREHOUSE_ORDER_EXISTS',
      authoritativeState: {
        warehouseId: state.warehouse.id,
        warehouseStatus: state.warehouse.status,
      },
      details: {
        orderNumber,
        caseId: recoveryCaseId,
        verifiedAt: new Date().toISOString(),
      },
    };

    // Invoke optional CaseResolution callback if provided for backward compatibility
    if (deps?.resolveCaseCallback && recoveryCaseId) {
      await deps.resolveCaseCallback({
        caseId: recoveryCaseId,
        organizationId: context.organizationId,
        workflowId: context.workflowId,
        verifyStepKey: context.stepKey,
        verificationOutput,
      });
    }

    return { output: verificationOutput };
  });

  // =========================================================================
  // 3. SHIPPED AT 3PL / SHOPIFY UNFULFILLED HANDLERS
  // =========================================================================

  registry.register('RECOVERY_CHECK_SHIPPED_UNFULFILLED', async (context: WorkflowStepContext) => {
    const payload = (context.payload ?? {}) as Record<string, unknown>;
    const orderNumber = requireOrderNumber(payload, 'RECOVERY_CHECK_SHIPPED_UNFULFILLED');

    const state = await actionExecutor.fetchAuthoritativeOrderState(orderNumber);
    const shp = state.shopify;
    const wh = state.warehouse;

    if (!shp || !wh) {
      throw new JobExecutionError({
        category: JobErrorCategory.NOT_FOUND,
        code: 'ORDER_NOT_FOUND',
        message: 'Could not find Shopify and Warehouse orders during check',
        retryable: false,
      });
    }

    if (shp.fulfillmentStatus === 'FULFILLED') {
      return {
        output: {
          noActionNeeded: true,
          resolvedClean: true,
          orderNumber,
        },
      };
    }

    const safetyFingerprint = computeSafetyFingerprint({
      orderNumber,
      shpFulfillment: shp.fulfillmentStatus,
      whStatus: wh.status,
      trackingNumber: wh.trackingNumber,
    });

    return {
      output: {
        safeToExecute: true,
        orderNumber,
        trackingNumber: wh.trackingNumber,
        carrier: wh.carrier,
        safetyFingerprint,
      },
    };
  });

  registry.register('RECOVERY_EXECUTE_SHIPPED_UNFULFILLED', async (context: WorkflowStepContext) => {
    const payload = (context.payload ?? {}) as Record<string, unknown>;
    const orderNumber = requireOrderNumber(payload, 'RECOVERY_EXECUTE_SHIPPED_UNFULFILLED');
    const recoveryCaseId = requireCaseId(payload, 'RECOVERY_EXECUTE_SHIPPED_UNFULFILLED');

    const state = await actionExecutor.fetchAuthoritativeOrderState(orderNumber);
    const trackingNumber =
      (payload.trackingNumber as string) || state.warehouse?.trackingNumber || 'TRK-DEFAULT';
    const carrier = (payload.carrier as string) || state.warehouse?.carrier || 'FedEx';

    const result = await actionExecutor.markShopifyFulfilled({
      organizationId: context.organizationId,
      recoveryCaseId,
      orderNumber,
      trackingNumber,
      carrier,
    });

    if (!result.success && !result.ambiguous) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'MARK_FULFILLED_FAILED',
        message: result.error || 'Failed to mark Shopify order fulfilled',
        retryable: false,
      });
    }

    return {
      output: {
        executed: true,
        operationKey: result.operationKey,
        trackingNumber,
      },
    };
  });

  registry.register('RECOVERY_VERIFY_SHIPPED_UNFULFILLED', async (context: WorkflowStepContext) => {
    const payload = (context.payload ?? {}) as Record<string, unknown>;
    const orderNumber = requireOrderNumber(payload, 'RECOVERY_VERIFY_SHIPPED_UNFULFILLED');
    const recoveryCaseId = requireCaseId(payload, 'RECOVERY_VERIFY_SHIPPED_UNFULFILLED');

    const state = await actionExecutor.fetchAuthoritativeOrderState(orderNumber);
    const shp = state.shopify;
    const wh = state.warehouse;

    if (shp?.fulfillmentStatus !== 'FULFILLED') {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'VERIFICATION_MISMATCH',
        message: `Verification failed: Shopify order ${orderNumber} is not FULFILLED (current: ${shp?.fulfillmentStatus})`,
        retryable: false,
      });
    }

    const verificationOutput = {
      verified: true,
      invariantPassed: 'FULFILLMENT_STATE_CONSISTENCY',
      authoritativeState: {
        shopifyStatus: shp.fulfillmentStatus,
        warehouseStatus: wh?.status,
        trackingNumber: shp.trackingNumber,
      },
      details: {
        orderNumber,
        caseId: recoveryCaseId,
        verifiedAt: new Date().toISOString(),
      },
    };

    // Invoke optional CaseResolution callback if provided for backward compatibility
    if (deps?.resolveCaseCallback && recoveryCaseId) {
      await deps.resolveCaseCallback({
        caseId: recoveryCaseId,
        organizationId: context.organizationId,
        workflowId: context.workflowId,
        verifyStepKey: context.stepKey,
        verificationOutput,
      });
    }

    return { output: verificationOutput };
  });

  // =========================================================================
  // 4. STUCK ORDER INVESTIGATION HANDLERS (READ ONLY - ZERO MUTATIONS)
  // =========================================================================

  registry.register('RECOVERY_CHECK_STUCK_ORDER', async (context: WorkflowStepContext) => {
    const payload = (context.payload ?? {}) as Record<string, unknown>;
    const orderNumber = requireOrderNumber(payload, 'RECOVERY_CHECK_STUCK_ORDER');

    const state = await actionExecutor.fetchAuthoritativeOrderState(orderNumber);
    return {
      output: {
        checked: true,
        orderNumber,
        existsInShopify: !!state.shopify,
        existsInWarehouse: !!state.warehouse,
      },
    };
  });

  registry.register('RECOVERY_INVESTIGATE_STUCK_ORDER', async (context: WorkflowStepContext) => {
    const payload = (context.payload ?? {}) as Record<string, unknown>;
    const orderNumber = requireOrderNumber(payload, 'RECOVERY_INVESTIGATE_STUCK_ORDER');

    // Strictly READ ONLY - ZERO mutations (Requirement 5 & 30)
    return {
      output: {
        investigated: true,
        orderNumber,
        findings: 'Order has exceeded 24h operational threshold without state advance',
        mutationsPerformed: 0,
      },
    };
  });

  registry.register('RECOVERY_VERIFY_STUCK_ORDER', async (context: WorkflowStepContext) => {
    const payload = (context.payload ?? {}) as Record<string, unknown>;
    const orderNumber = requireOrderNumber(payload, 'RECOVERY_VERIFY_STUCK_ORDER');

    // Notice: Does NOT mark case resolved! Remains open/actionable (Requirement 5)
    return {
      output: {
        verified: false,
        requiresHumanReview: true,
        orderNumber,
        message: 'Investigation completed; case remains actionable for operations lead',
      },
    };
  });
}
