import { RecoveryCase, RecoveryLevel, RecoveryCaseType } from '@prisma/client';

export type RoutingAction = 'START_WORKFLOW' | 'INVESTIGATE_ONLY' | 'BLOCKED';

export interface RoutingDecision {
  action: RoutingAction;
  templateKey?: string;
  templateVersion?: number;
  reason: string;
  recoveryLevel: RecoveryLevel;
}

/**
 * Pure deterministic recovery policy routing function.
 * Maps canonical RecoveryCaseType + RecoveryLevel to workflow templates without AI.
 */
export function routeRecoveryPolicy(recoveryCase: RecoveryCase): RoutingDecision {
  const { type, recoveryLevel } = recoveryCase;

  // Rule 4 & 37: BLOCK MUST NEVER EXECUTE
  // Neither DUPLICATE_RISK, INVALID_ORDER_DATA, nor any other BLOCK-level issue
  // may start an executable recovery workflow, Job, or Approval.
  if (recoveryLevel === RecoveryLevel.BLOCK) {
    return {
      action: 'BLOCKED',
      reason: `Automated recovery is strictly blocked for category ${type} at BLOCK level`,
      recoveryLevel: RecoveryLevel.BLOCK,
    };
  }

  // Rule 5: AUTO_INVESTIGATE IS READ-ONLY
  // STUCK_ORDER or investigative levels trigger read-only investigation workflow.
  // Must NOT perform any mutating recovery action.
  if (recoveryLevel === RecoveryLevel.AUTO_INVESTIGATE || type === RecoveryCaseType.STUCK_ORDER) {
    return {
      action: 'INVESTIGATE_ONLY',
      templateKey: 'RECOVERY_STUCK_INVESTIGATION',
      templateVersion: 1,
      reason: 'Read-only investigation workflow for stuck order (zero mutations)',
      recoveryLevel: RecoveryLevel.AUTO_INVESTIGATE,
    };
  }

  // Rule 38: INVENTORY_MISMATCH MUST NOT AUTOMATICALLY MUTATE INVENTORY
  if (type === RecoveryCaseType.INVENTORY_MISMATCH) {
    return {
      action: 'BLOCKED',
      reason: 'Inventory mismatch requires human business decision; automated mutation blocked on Day 13',
      recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
    };
  }

  // Rule 39: TEMPORARY_API_FAILURE: safe read/retry investigation only
  if (type === RecoveryCaseType.TEMPORARY_API_FAILURE) {
    return {
      action: 'INVESTIGATE_ONLY',
      reason: 'Temporary API failure routes to retry investigation; zero business mutations',
      recoveryLevel: RecoveryLevel.AUTO_RECOVER,
    };
  }

  // Rule 16: AUTO_RECOVER for missing tracking
  if (recoveryLevel === RecoveryLevel.AUTO_RECOVER) {
    if (type === RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY) {
      return {
        action: 'START_WORKFLOW',
        templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
        templateVersion: 1,
        reason: 'Automated recovery workflow for missing Shopify tracking (CHECK -> EXECUTE -> VERIFY)',
        recoveryLevel: RecoveryLevel.AUTO_RECOVER,
      };
    }
  }

  // Rule 3 & 45: REQUIRE_APPROVAL
  if (recoveryLevel === RecoveryLevel.REQUIRE_APPROVAL) {
    switch (type) {
      case RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY:
        return {
          action: 'START_WORKFLOW',
          templateKey: 'RECOVERY_TRACKING_MISSING_APPROVAL',
          templateVersion: 1,
          reason: 'Approval-gated recovery for degraded/conflicting missing tracking',
          recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
        };

      case RecoveryCaseType.ORDER_MISSING_AT_3PL:
        return {
          action: 'START_WORKFLOW',
          templateKey: 'RECOVERY_ORDER_MISSING_3PL',
          templateVersion: 1,
          reason: 'Approval-gated recovery for missing order at 3PL warehouse',
          recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
        };

      case RecoveryCaseType.SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY:
        return {
          action: 'START_WORKFLOW',
          templateKey: 'RECOVERY_SHIPPED_UNFULFILLED',
          templateVersion: 1,
          reason: 'Approval-gated recovery for 3PL shipped order unfulfilled in Shopify',
          recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
        };

      default:
        return {
          action: 'BLOCKED',
          reason: `No executable recovery template configured for category ${type}`,
          recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
        };
    }
  }

  return {
    action: 'BLOCKED',
    reason: `Unrecognized recovery level: ${recoveryLevel}`,
    recoveryLevel: recoveryLevel,
  };
}
