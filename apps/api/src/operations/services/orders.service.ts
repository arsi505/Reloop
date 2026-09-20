import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  Prisma,
  IntegrationProvider,
  RecoveryCaseStatus,
} from '@reloop/database';
import {
  OrdersQueryDto,
  OrderListItemDto,
  OrderDetailDto,
  ShopifyCrossSystemStateDto,
  ShipStationCrossSystemStateDto,
  Generic3plCrossSystemStateDto,
  OrderExternalReferenceDto,
  OrderRelatedExceptionDto,
  CrossSystemDiscrepancyDto,
} from '../dto/orders.dto';
import { PaginatedResponse } from '../dto/pagination.dto';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lists unified logical orders with cross-system provider rollups and exception indicators.
   */
  async listOrders(
    organizationId: string,
    query: OrdersQueryDto,
  ): Promise<PaginatedResponse<OrderListItemDto>> {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
    const skip = (page - 1) * pageSize;
    const sortOrder = query.sortOrder === 'asc' ? 'asc' : 'desc';

    const where: Prisma.ExternalOrderWhereInput = {
      organizationId,
    };

    if (query.status) {
      where.status = query.status;
    }

    if (query.provider) {
      where.OR = [
        { primaryIntegration: { provider: query.provider } },
        { externalReferences: { some: { integration: { provider: query.provider } } } },
      ];
    }

    const openStatuses: RecoveryCaseStatus[] = [
      RecoveryCaseStatus.OPEN,
      RecoveryCaseStatus.INVESTIGATING,
      RecoveryCaseStatus.WAITING_APPROVAL,
      RecoveryCaseStatus.RECOVERING,
      RecoveryCaseStatus.VERIFYING,
      RecoveryCaseStatus.READY_FOR_RECOVERY,
      RecoveryCaseStatus.AUTO_RECOVERING,
    ];

    if (query.hasException === true) {
      where.recoveryCases = {
        some: { status: { in: openStatuses } },
      };
    } else if (query.hasException === false) {
      where.recoveryCases = {
        none: { status: { in: openStatuses } },
      };
    }

    if (query.search && query.search.trim().length > 0) {
      const searchTerm = query.search.trim();
      where.OR = [
        { externalOrderNumber: { contains: searchTerm, mode: 'insensitive' } },
        { customerReference: { contains: searchTerm, mode: 'insensitive' } },
      ];
    }

    const [total, records] = await Promise.all([
      this.prisma.externalOrder.count({ where }),
      this.prisma.externalOrder.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { lastObservedAt: sortOrder },
        include: {
          primaryIntegration: {
            select: { provider: true },
          },
          externalReferences: {
            select: {
              integration: {
                select: { provider: true },
              },
            },
          },
          recoveryCases: {
            select: { id: true, status: true },
          },
        },
      }),
    ]);

    const items: OrderListItemDto[] = records.map((order) => {
      const connectedProvidersSet = new Set<IntegrationProvider>();
      if (order.primaryIntegration?.provider) {
        connectedProvidersSet.add(order.primaryIntegration.provider);
      }
      for (const ref of order.externalReferences) {
        if (ref.integration?.provider) {
          connectedProvidersSet.add(ref.integration.provider);
        }
      }

      const activeExceptionCount = order.recoveryCases.filter((rc) =>
        openStatuses.includes(rc.status),
      ).length;

      return {
        id: order.id,
        externalOrderNumber: order.externalOrderNumber,
        customerReference: order.customerReference,
        status: order.status,
        currency: order.currency,
        totalAmount: order.totalAmount?.toString() || null,
        sourceCreatedAt: order.sourceCreatedAt,
        lastObservedAt: order.lastObservedAt,
        primaryProvider: order.primaryIntegration?.provider || null,
        connectedProviders: Array.from(connectedProvidersSet),
        activeExceptionCount,
        hasOpenException: activeExceptionCount > 0,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      };
    });

    const totalPages = Math.ceil(total / pageSize) || 1;

    return {
      items,
      page,
      pageSize,
      total,
      totalPages,
    };
  }

  /**
   * Retrieves cross-system order detail presenting unified factual states across providers.
   */
  async getOrderDetail(organizationId: string, id: string): Promise<OrderDetailDto> {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(id)) {
      throw new NotFoundException(`Order ${id} not found`);
    }

    const order = await this.prisma.externalOrder.findFirst({
      where: {
        id,
        organizationId,
      },
      include: {
        primaryIntegration: true,
        externalReferences: {
          include: {
            integration: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        recoveryCases: {
          orderBy: { detectedAt: 'desc' },
        },
      },
    });

    if (!order) {
      throw new NotFoundException(`Order ${id} not found`);
    }

    // Extract all unique tracking numbers
    const trackingNumbersSet = new Set<string>();
    const formattedReferences: OrderExternalReferenceDto[] = [];

    // Group references by provider
    const shopifyRefs = order.externalReferences.filter(
      (r) => r.integration.provider === IntegrationProvider.SHOPIFY,
    );
    const shipstationRefs = order.externalReferences.filter(
      (r) => r.integration.provider === IntegrationProvider.SHIPSTATION,
    );
    const generic3plRefs = order.externalReferences.filter(
      (r) =>
        r.integration.provider === IntegrationProvider.GENERIC_3PL ||
        r.integration.provider === IntegrationProvider.SIMULATOR,
    );

    for (const ref of order.externalReferences) {
      if (ref.resourceType === 'TRACKING' && ref.externalId) {
        trackingNumbersSet.add(ref.externalId);
      }
      formattedReferences.push({
        id: ref.id,
        provider: ref.integration.provider,
        resourceType: ref.resourceType,
        externalId: ref.externalId,
        externalReference: ref.externalReference,
        createdAt: ref.createdAt,
      });
    }

    // Build Shopify factual state
    let shopifyState: ShopifyCrossSystemStateDto | null = null;
    if (shopifyRefs.length > 0 || order.primaryIntegration?.provider === IntegrationProvider.SHOPIFY) {
      const shopifyTracking = shopifyRefs
        .filter((r) => r.resourceType === 'TRACKING')
        .map((r) => r.externalId);

      shopifyState = {
        fulfillmentStatus: order.status === 'SHIPPED' ? 'FULFILLED' : 'UNFULFILLED',
        trackingNumbers: shopifyTracking,
        lastObservedAt: order.lastObservedAt,
      };
    }

    // Build ShipStation factual state
    let shipstationState: ShipStationCrossSystemStateDto | null = null;
    if (shipstationRefs.length > 0) {
      const ssTracking: string[] = [];
      const ssCarriers: string[] = [];
      let labelCount = 0;
      let voidedLabelCount = 0;

      for (const ref of shipstationRefs) {
        if (ref.resourceType === 'LABEL') {
          labelCount++;
          try {
            const parsed = ref.externalReference ? JSON.parse(ref.externalReference) : {};
            if (parsed.voided === true || parsed.status === 'voided') {
              voidedLabelCount++;
            }
          } catch {
            // Safe JSON parse fallback
          }
        } else if (ref.resourceType === 'TRACKING') {
          ssTracking.push(ref.externalId);
          if (ref.externalReference) {
            ssCarriers.push(ref.externalReference);
          }
        }
      }

      shipstationState = {
        shipmentStatus: labelCount > 0 ? 'LABEL_CREATED' : 'PROCESSING',
        trackingNumbers: ssTracking,
        carrierCodes: Array.from(new Set(ssCarriers)),
        labelCount,
        voidedLabelCount,
        lastObservedAt: shipstationRefs[0]?.createdAt || order.lastObservedAt,
      };
    }

    // Build 3PL factual state
    let generic3plState: Generic3plCrossSystemStateDto | null = null;
    if (generic3plRefs.length > 0) {
      const trackingRef = generic3plRefs.find((r) => r.resourceType === 'TRACKING');
      generic3plState = {
        warehouseStatus: order.status.toString(),
        trackingNumber: trackingRef?.externalId || null,
        lastObservedAt: generic3plRefs[0]?.createdAt || order.lastObservedAt,
      };
    }

    // Detect factual cross-system discrepancies
    const discrepancy = this.detectCrossSystemDiscrepancy(shopifyState, shipstationState, generic3plState);

    const relatedExceptions: OrderRelatedExceptionDto[] = order.recoveryCases.map((rc) => ({
      id: rc.id,
      type: rc.type,
      recoveryLevel: rc.recoveryLevel,
      status: rc.status,
      summary: rc.summary,
      detectedAt: rc.detectedAt,
    }));

    return {
      id: order.id,
      externalOrderNumber: order.externalOrderNumber,
      customerReference: order.customerReference,
      status: order.status,
      currency: order.currency,
      totalAmount: order.totalAmount?.toString() || null,
      sourceCreatedAt: order.sourceCreatedAt,
      lastObservedAt: order.lastObservedAt,
      shopifyState,
      shipstationState,
      generic3plState,
      trackingNumbers: Array.from(trackingNumbersSet),
      externalReferences: formattedReferences,
      relatedExceptions,
      crossSystemDiscrepancy: discrepancy,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  private detectCrossSystemDiscrepancy(
    shopify: ShopifyCrossSystemStateDto | null,
    shipstation: ShipStationCrossSystemStateDto | null,
    generic3pl: Generic3plCrossSystemStateDto | null,
  ): CrossSystemDiscrepancyDto | null {
    if (shopify && shipstation) {
      const shopifyHasTracking = shopify.trackingNumbers.length > 0;
      const shipstationHasActiveTracking =
        shipstation.trackingNumbers.length > 0 &&
        shipstation.labelCount > shipstation.voidedLabelCount;

      if (!shopifyHasTracking && shipstationHasActiveTracking) {
        return {
          hasDiscrepancy: true,
          summary: `Tracking number ${shipstation.trackingNumbers[0]} exists in ShipStation but is missing in Shopify.`,
          details: {
            discrepancyType: 'TRACKING_MISSING_IN_SHOPIFY',
            shopifyTrackingCount: shopify.trackingNumbers.length,
            shipstationTrackingCount: shipstation.trackingNumbers.length,
            shipstationTracking: shipstation.trackingNumbers,
          },
        };
      }
    }

    if (shopify && generic3pl) {
      if (generic3pl.warehouseStatus === 'SHIPPED' && shopify.fulfillmentStatus === 'UNFULFILLED') {
        return {
          hasDiscrepancy: true,
          summary: 'Order is marked SHIPPED at 3PL warehouse but remains UNFULFILLED in Shopify.',
          details: {
            discrepancyType: 'SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY',
          },
        };
      }
    }

    return null;
  }
}
