import { Injectable } from '@nestjs/common';
import {
  ShopifyOrder,
  ShipStationShipment,
  WarehouseOrder,
  FaultRule,
} from '@reloop/connector-simulator';

@Injectable()
export class SimulatorStateService {
  // Shopify State
  public shopifyOrders = new Map<string, ShopifyOrder>();
  public shopifyOrderByNumber = new Map<string, string>();
  public shopifyInventory = new Map<string, number>();

  // ShipStation State
  public shipstationShipments = new Map<string, ShipStationShipment>();
  public shipstationByOrderNumber = new Map<string, string>();

  // Generic 3PL Warehouse State
  public warehouseOrders = new Map<string, WarehouseOrder>();
  public warehouseOrderByNumber = new Map<string, string>();
  public warehouseOrderByRef = new Map<string, string>();
  public warehouseInventory = new Map<string, number>();

  // Fault Injection Rules
  public faultRules: FaultRule[] = [];

  /**
   * Resets ONLY the in-memory simulator state.
   * Completely isolated: does not touch database, redis, or auth.
   */
  reset(): void {
    this.shopifyOrders.clear();
    this.shopifyOrderByNumber.clear();
    this.shopifyInventory.clear();

    this.shipstationShipments.clear();
    this.shipstationByOrderNumber.clear();

    this.warehouseOrders.clear();
    this.warehouseOrderByNumber.clear();
    this.warehouseOrderByRef.clear();
    this.warehouseInventory.clear();

    this.faultRules = [];
  }

  // --- Shopify Helpers ---
  saveShopifyOrder(order: ShopifyOrder): ShopifyOrder {
    this.shopifyOrders.set(order.id, { ...order });
    this.shopifyOrderByNumber.set(order.orderNumber, order.id);
    return order;
  }

  getShopifyOrder(id: string): ShopifyOrder | undefined {
    const o = this.shopifyOrders.get(id);
    return o ? { ...o } : undefined;
  }

  getShopifyOrderByNumber(orderNumber: string): ShopifyOrder | undefined {
    const id = this.shopifyOrderByNumber.get(orderNumber);
    return id ? this.getShopifyOrder(id) : undefined;
  }

  listShopifyOrders(): ShopifyOrder[] {
    return Array.from(this.shopifyOrders.values()).map((o) => ({ ...o }));
  }

  setShopifyInventory(sku: string, quantity: number): void {
    this.shopifyInventory.set(sku, quantity);
  }

  getShopifyInventory(sku: string): number | undefined {
    return this.shopifyInventory.get(sku);
  }

  // --- ShipStation Helpers ---
  saveShipment(shipment: ShipStationShipment): ShipStationShipment {
    this.shipstationShipments.set(shipment.id, { ...shipment });
    this.shipstationByOrderNumber.set(shipment.orderNumber, shipment.id);
    return shipment;
  }

  getShipment(id: string): ShipStationShipment | undefined {
    const s = this.shipstationShipments.get(id);
    return s ? { ...s } : undefined;
  }

  getShipmentByOrderNumber(orderNumber: string): ShipStationShipment | undefined {
    const id = this.shipstationByOrderNumber.get(orderNumber);
    return id ? this.getShipment(id) : undefined;
  }

  listShipments(): ShipStationShipment[] {
    return Array.from(this.shipstationShipments.values()).map((s) => ({ ...s }));
  }

  // --- 3PL Helpers ---
  saveWarehouseOrder(order: WarehouseOrder): WarehouseOrder {
    this.warehouseOrders.set(order.id, { ...order });
    this.warehouseOrderByNumber.set(order.orderNumber, order.id);
    if (order.externalReference) {
      this.warehouseOrderByRef.set(order.externalReference, order.id);
    }
    return order;
  }

  getWarehouseOrder(id: string): WarehouseOrder | undefined {
    const o = this.warehouseOrders.get(id);
    return o ? { ...o } : undefined;
  }

  getWarehouseOrderByNumber(orderNumber: string): WarehouseOrder | undefined {
    const id = this.warehouseOrderByNumber.get(orderNumber);
    return id ? this.getWarehouseOrder(id) : undefined;
  }

  getWarehouseOrderByRef(ref: string): WarehouseOrder | undefined {
    const id = this.warehouseOrderByRef.get(ref);
    return id ? this.getWarehouseOrder(id) : undefined;
  }

  listWarehouseOrders(): WarehouseOrder[] {
    return Array.from(this.warehouseOrders.values()).map((o) => ({ ...o }));
  }

  setWarehouseInventory(sku: string, quantity: number): void {
    this.warehouseInventory.set(sku, quantity);
  }

  getWarehouseInventory(sku: string): number | undefined {
    return this.warehouseInventory.get(sku);
  }

  // --- Fault Rule Helpers ---
  addFaultRule(rule: FaultRule): FaultRule {
    const ruleWithId = {
      ...rule,
      id: rule.id || `fault_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    };
    this.faultRules.push(ruleWithId);
    return ruleWithId;
  }

  getMatchingFault(provider: string, method: string, path: string): FaultRule | undefined {
    const index = this.faultRules.findIndex((r) => {
      if (r.remainingCount <= 0) return false;
      if (r.provider && r.provider !== 'all' && r.provider !== provider) return false;
      if (r.method && r.method !== 'ALL' && r.method.toUpperCase() !== method.toUpperCase()) return false;
      if (r.pathPattern && !path.includes(r.pathPattern)) return false;
      return true;
    });

    if (index === -1) return undefined;

    const rule = this.faultRules[index];
    rule.remainingCount -= 1;
    if (rule.remainingCount <= 0) {
      this.faultRules.splice(index, 1);
    }
    return rule;
  }

  getFullState() {
    return {
      shopify: {
        ordersCount: this.shopifyOrders.size,
        orders: this.listShopifyOrders(),
        inventory: Object.fromEntries(this.shopifyInventory.entries()),
      },
      shipstation: {
        shipmentsCount: this.shipstationShipments.size,
        shipments: this.listShipments(),
      },
      threePl: {
        ordersCount: this.warehouseOrders.size,
        orders: this.listWarehouseOrders(),
        inventory: Object.fromEntries(this.warehouseInventory.entries()),
      },
      faultRulesCount: this.faultRules.length,
      faultRules: this.faultRules,
    };
  }
}