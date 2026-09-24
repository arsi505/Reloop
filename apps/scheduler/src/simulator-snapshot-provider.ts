import { PrismaClient } from '@prisma/client';
import {
  NormalizedOrderSnapshot,
  ShipStationShipmentSnapshot,
  ShopifyOrderSnapshot,
  WarehouseOrderSnapshot,
} from '@reloop/reconciliation-core';
import { OrderSnapshotProvider } from './reconciliation-scanner';

interface SimulatorShopifyOrder {
  id: string;
  orderNumber: string;
  lineItems: Array<{ sku: string; name?: string; quantity: number }>;
  paymentStatus: string;
  fulfillmentStatus: ShopifyOrderSnapshot['fulfillmentStatus'];
  trackingNumber?: string;
  carrier?: string;
  shippingAddress?: { postalCode?: string };
  createdAt: string;
  updatedAt: string;
}

interface SimulatorWarehouseOrder {
  id: string;
  orderNumber: string;
  externalReference?: string;
  lineItems: Array<{ sku: string; name?: string; quantity: number }>;
  status: WarehouseOrderSnapshot['status'];
  trackingNumber?: string;
  carrier?: string;
  rejectedReason?: string;
  createdAt: string;
  updatedAt: string;
}

interface SimulatorShipment {
  id: string;
  orderNumber: string;
  carrier: string;
  trackingNumber?: string;
  status: ShipStationShipmentSnapshot['status'];
  createdAt: string;
  updatedAt: string;
}

export interface SimulatorOrderSnapshotProviderOptions {
  fetchFn?: typeof fetch;
}

/**
 * Reads authoritative demo/provider state from the running simulator while using
 * PostgreSQL ExternalOrder rows as the tenant-scoped scan boundary.
 */
export class SimulatorOrderSnapshotProvider implements OrderSnapshotProvider {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly prisma: PrismaClient,
    simulatorBaseUrl: string,
    options: SimulatorOrderSnapshotProviderOptions = {},
  ) {
    const parsed = new URL(simulatorBaseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `Invalid simulatorBaseUrl protocol "${parsed.protocol}"; expected http: or https:`,
      );
    }
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async fetchSnapshots(
    organizationId: string,
    limit: number,
  ): Promise<NormalizedOrderSnapshot[]> {
    const orders = await this.prisma.externalOrder.findMany({
      where: { organizationId },
      orderBy: { lastObservedAt: 'asc' },
      take: limit,
      select: {
        id: true,
        externalOrderNumber: true,
      },
    });

    return Promise.all(
      orders.map(async (order) => {
        const encodedOrderNumber = encodeURIComponent(order.externalOrderNumber);
        const [shopify, warehouse, shipstation] = await Promise.all([
          this.fetchOptional<SimulatorShopifyOrder>(
            `/shopify/orders/${encodedOrderNumber}`,
          ),
          this.fetchOptional<SimulatorWarehouseOrder>(
            `/3pl/orders/search?orderNumber=${encodedOrderNumber}`,
          ),
          this.fetchOptional<SimulatorShipment>(
            `/shipstation/shipments/by-order/${encodedOrderNumber}`,
          ),
        ]);

        return {
          organizationId,
          orderNumber: order.externalOrderNumber,
          externalOrderId: order.id,
          shopify: shopify ? this.toShopifySnapshot(shopify) : undefined,
          warehouse: warehouse ? this.toWarehouseSnapshot(warehouse) : undefined,
          shipstation: shipstation
            ? this.toShipStationSnapshot(shipstation)
            : undefined,
        };
      }),
    );
  }

  private async fetchOptional<T>(path: string): Promise<T | undefined> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Simulator snapshot request failed for ${path}: ${message}`,
      );
    }

    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(
        `Simulator snapshot request failed for ${path}: HTTP ${response.status}`,
      );
    }

    return (await response.json()) as T;
  }

  private toShopifySnapshot(order: SimulatorShopifyOrder): ShopifyOrderSnapshot {
    const postalCode = order.shippingAddress?.postalCode;
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      fulfillmentStatus: order.fulfillmentStatus,
      trackingNumber: order.trackingNumber,
      carrier: order.carrier,
      lineItems: order.lineItems.map((item) => ({
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
      })),
      addressValid:
        postalCode === undefined
          ? undefined
          : postalCode !== '00000' && postalCode !== 'INVALID',
      paymentStatus: order.paymentStatus,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  private toWarehouseSnapshot(
    order: SimulatorWarehouseOrder,
  ): WarehouseOrderSnapshot {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      externalReference: order.externalReference,
      status: order.status,
      trackingNumber: order.trackingNumber,
      carrier: order.carrier,
      lineItems: order.lineItems.map((item) => ({
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
      })),
      rejectedReason: order.rejectedReason,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  private toShipStationSnapshot(
    shipment: SimulatorShipment,
  ): ShipStationShipmentSnapshot {
    return {
      id: shipment.id,
      orderNumber: shipment.orderNumber,
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      status: shipment.status,
      createdAt: shipment.createdAt,
      updatedAt: shipment.updatedAt,
    };
  }
}
