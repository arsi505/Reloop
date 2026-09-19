import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  RecoveryCase,
  RecoveryCaseStatus,
  RecoveryCaseType,
  RecoveryLevel,
} from '@reloop/database';
import {
  reconcileOrder,
  NormalizedOrderSnapshot,
  ShopifyOrderSnapshot,
  WarehouseOrderSnapshot,
  ShipStationShipmentSnapshot,
  ReconciliationFinding,
} from '@reloop/reconciliation-core';
import { PrismaService } from '../prisma/prisma.service';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class TargetedReconciliationService {
  private readonly logger = new Logger(TargetedReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persists reconciliation findings as RecoveryCase instances using transactional advisory locking.
   * Reuses existing active cases and creates new cases for fresh discrepancies.
   * Zero Jobs, Zero Approvals, Zero Workflows created.
   */
  async persistFindings(
    organizationId: string,
    findings: ReconciliationFinding[],
    externalOrderId?: string,
  ): Promise<RecoveryCase[]> {
    if (!findings || findings.length === 0) {
      return [];
    }

    const validExternalOrderId =
      externalOrderId && UUID_REGEX.test(externalOrderId)
        ? externalOrderId
        : null;

    const persistedCases: RecoveryCase[] = [];

    for (const finding of findings) {
      const orderNumber = finding.orderIdentity.orderNumber || 'system';
      const dedupeKey = `${orderNumber}:${finding.category}`;

      const recoveryCase = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext('reloop:case:' || ${organizationId} || ':' || ${dedupeKey}))
        `;

        const existingActive = await tx.recoveryCase.findFirst({
          where: {
            organizationId,
            dedupeKey,
            status: {
              notIn: [RecoveryCaseStatus.RESOLVED, RecoveryCaseStatus.FAILED],
            },
          },
        });

        if (existingActive) {
          return tx.recoveryCase.update({
            where: { id: existingActive.id },
            data: {
              summary: finding.summary,
              recoveryLevel: finding.recoveryLevel as RecoveryLevel,
              evidence: finding.evidence as unknown as Prisma.InputJsonValue,
              updatedAt: new Date(),
            },
          });
        }

        return tx.recoveryCase.create({
          data: {
            organizationId,
            externalOrderId: validExternalOrderId,
            dedupeKey,
            type: finding.category as RecoveryCaseType,
            recoveryLevel: finding.recoveryLevel as RecoveryLevel,
            status: RecoveryCaseStatus.OPEN,
            summary: finding.summary,
            evidence: finding.evidence as unknown as Prisma.InputJsonValue,
            detectedAt: new Date(),
          },
        });
      });

      persistedCases.push(recoveryCase);
    }

    return persistedCases;
  }

  /**
   * Reconciles a single order based on current projected external state.
   */
  async reconcileTargetedOrder(
    organizationId: string,
    orderNumber: string,
    _externalOrderId?: string,
  ): Promise<{ findings: ReconciliationFinding[]; cases: RecoveryCase[] }> {
    const externalOrder = await this.prisma.externalOrder.findFirst({
      where: {
        organizationId,
        externalOrderNumber: orderNumber,
      },
      include: {
        externalReferences: {
          include: {
            integration: true,
          },
        },
      },
    });

    if (!externalOrder) {
      return { findings: [], cases: [] };
    }

    let shopifySnapshot: ShopifyOrderSnapshot | undefined;
    let warehouseSnapshot: WarehouseOrderSnapshot | undefined;
    let shipstationSnapshot: ShipStationShipmentSnapshot | undefined;

    for (const ref of externalOrder.externalReferences) {
      let parsedData: any = {};
      if (ref.externalReference) {
        try {
          parsedData = JSON.parse(ref.externalReference);
        } catch {
          parsedData = { raw: ref.externalReference };
        }
      }

      const provider = ref.integration.provider;
      const resourceType = ref.resourceType.toUpperCase();

      if (provider === 'SHOPIFY' || resourceType === 'SHOPIFY_ORDER') {
        shopifySnapshot = {
          id: ref.externalId,
          orderNumber,
          fulfillmentStatus:
            parsedData.fulfillmentStatus ||
            (parsedData.status === 'UNFULFILLED' || parsedData.status === 'PARTIAL'
              ? parsedData.status
              : parsedData.status === 'FULFILLED'
              ? 'FULFILLED'
              : 'UNFULFILLED'),
          trackingNumber: parsedData.trackingNumber,
          carrier: parsedData.carrier,
          lineItems:
            parsedData.lineItems && parsedData.lineItems.length > 0
              ? parsedData.lineItems
              : [{ sku: 'SKU-DEFAULT', quantity: 1 }],
          addressValid: true,
          createdAt: externalOrder.sourceCreatedAt?.toISOString() || externalOrder.createdAt.toISOString(),
          updatedAt: externalOrder.updatedAt.toISOString(),
          error: parsedData.error,
        };
      } else if (provider === 'GENERIC_3PL' || resourceType === 'WAREHOUSE_ORDER') {
        warehouseSnapshot = {
          id: ref.externalId,
          orderNumber,
          externalReference: parsedData.externalReference || orderNumber,
          status: parsedData.status || (externalOrder.status === 'SHIPPED' ? 'SHIPPED' : 'RECEIVED'),
          trackingNumber: parsedData.trackingNumber,
          carrier: parsedData.carrier,
          lineItems:
            parsedData.lineItems && parsedData.lineItems.length > 0
              ? parsedData.lineItems
              : [{ sku: 'SKU-DEFAULT', quantity: 1 }],
          candidateOrders: parsedData.candidateOrders,
          createdAt: externalOrder.createdAt.toISOString(),
          updatedAt: externalOrder.updatedAt.toISOString(),
          error: parsedData.error,
        };
      } else if (provider === 'SHIPSTATION' || resourceType === 'SHIPSTATION_SHIPMENT') {
        shipstationSnapshot = {
          id: ref.externalId,
          orderNumber,
          carrier: parsedData.carrier || 'Standard',
          trackingNumber: parsedData.trackingNumber || '',
          status: parsedData.status || 'SHIPPED',
          candidateShipments: parsedData.candidateShipments,
          createdAt: externalOrder.createdAt.toISOString(),
          updatedAt: externalOrder.updatedAt.toISOString(),
          error: parsedData.error,
        };
      }
    }

    const orderSnapshot: NormalizedOrderSnapshot = {
      organizationId,
      orderNumber,
      externalOrderId: externalOrder.id,
      shopify: shopifySnapshot,
      warehouse: warehouseSnapshot,
      shipstation: shipstationSnapshot,
    };

    const findings = reconcileOrder(orderSnapshot);
    const cases = await this.persistFindings(organizationId, findings, externalOrder.id);

    return { findings, cases };
  }
}
