import { Injectable, BadRequestException } from '@nestjs/common';
import { SimulatorStateService } from '../state/simulator-state.service';
import {
  ScenarioName,
  ShopifyOrder,
  ShipStationShipment,
  WarehouseOrder,
} from '@reloop/connector-simulator';

@Injectable()
export class ScenarioRunnerService {
  constructor(private readonly stateService: SimulatorStateService) {}

  seedScenario(scenario: ScenarioName) {
    switch (scenario) {
      case 'HEALTHY_ORDER':
        return this.seedHealthyOrder();
      case 'TEMPORARY_3PL_FAILURE':
        return this.seedTemporary3plFailure();
      case 'TRACKING_MISSING_IN_SHOPIFY':
        return this.seedTrackingMissingInShopify();
      case 'STUCK_ORDER':
        return this.seedStuckOrder();
      case 'MISSING_AT_3PL':
        return this.seedMissingAt3pl();
      case 'SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY':
        return this.seedShippedAt3plUnfulfilledAtShopify();
      case 'INVENTORY_MISMATCH':
        return this.seedInventoryMismatch();
      case 'DUPLICATE_RISK':
        return this.seedDuplicateRisk();
      case 'INVALID_ORDER_DATA':
        return this.seedInvalidOrderData();
      case 'AMBIGUOUS_TIMEOUT':
        return this.seedAmbiguousTimeout();
      default:
        throw new BadRequestException(`Unknown scenario: ${scenario}`);
    }
  }

  private seedHealthyOrder() {
    const now = new Date().toISOString();
    const orderNumber = 'ORD-9001';

    const shopifyOrder: ShopifyOrder = {
      id: 'shp_order_9001',
      orderNumber,
      customer: {
        name: 'Jordan Hayes',
        email: 'jordan@example.com',
      },
      shippingAddress: {
        street: '100 Market St',
        city: 'San Francisco',
        state: 'CA',
        postalCode: '94105',
        country: 'US',
      },
      lineItems: [
        { sku: 'PROD-WIDGET-01', name: 'Premium Widget', quantity: 2, price: 29.99 },
      ],
      paymentStatus: 'PAID',
      fulfillmentStatus: 'UNFULFILLED',
      createdAt: now,
      updatedAt: now,
    };
    this.stateService.saveShopifyOrder(shopifyOrder);
    this.stateService.setShopifyInventory('PROD-WIDGET-01', 50);

    const shipment: ShipStationShipment = {
      id: 'ship_9001',
      orderNumber,
      carrier: 'UPS',
      trackingNumber: 'TRK-UPS-9001',
      status: 'PENDING',
      shippingAddress: shopifyOrder.shippingAddress,
      createdAt: now,
      updatedAt: now,
    };
    this.stateService.saveShipment(shipment);

    const warehouseOrder: WarehouseOrder = {
      id: 'wh_order_9001',
      orderNumber,
      externalReference: 'EXT-REF-9001',
      customer: shopifyOrder.customer,
      shippingAddress: shopifyOrder.shippingAddress,
      lineItems: shopifyOrder.lineItems,
      status: 'RECEIVED',
      createdAt: now,
      updatedAt: now,
    };
    this.stateService.saveWarehouseOrder(warehouseOrder);
    this.stateService.setWarehouseInventory('PROD-WIDGET-01', 50);

    return {
      scenario: 'HEALTHY_ORDER',
      orderNumber,
      details: 'Healthy order seeded across Shopify, ShipStation, and 3PL.',
    };
  }

  private seedTemporary3plFailure() {
    const res = this.seedHealthyOrder();
    this.stateService.addFaultRule({
      fault: 'RETURN_503',
      provider: '3pl',
      method: 'ALL',
      remainingCount: 1,
    });
    return {
      ...res,
      scenario: 'TEMPORARY_3PL_FAILURE',
      details: 'Healthy order seeded; next 3PL request will return HTTP 503.',
    };
  }

  private seedTrackingMissingInShopify() {
    const now = new Date().toISOString();
    const orderNumber = 'ORD-9002';
    const trackingNumber = 'TRK-UPS-987654321';
    const carrier = 'UPS';

    // In Shopify: order is PAID but still UNFULFILLED and has NO tracking number
    const shopifyOrder: ShopifyOrder = {
      id: 'shp_order_9002',
      orderNumber,
      customer: {
        name: 'Alex Mercer',
        email: 'alex.mercer@example.com',
      },
      shippingAddress: {
        street: '200 Pine St',
        city: 'Seattle',
        state: 'WA',
        postalCode: '98101',
        country: 'US',
      },
      lineItems: [
        { sku: 'PROD-GADGET-02', name: 'Smart Sensor Gadget', quantity: 1, price: 49.99 },
      ],
      paymentStatus: 'PAID',
      fulfillmentStatus: 'UNFULFILLED', // Tracking missing here!
      createdAt: now,
      updatedAt: now,
    };
    this.stateService.saveShopifyOrder(shopifyOrder);

    // In ShipStation: tracking number exists and status is IN_TRANSIT
    const shipment: ShipStationShipment = {
      id: 'ship_9002',
      orderNumber,
      carrier,
      trackingNumber,
      status: 'IN_TRANSIT',
      shippingAddress: shopifyOrder.shippingAddress,
      createdAt: now,
      updatedAt: now,
    };
    this.stateService.saveShipment(shipment);

    // In 3PL: order is SHIPPED with tracking number
    const warehouseOrder: WarehouseOrder = {
      id: 'wh_order_9002',
      orderNumber,
      externalReference: 'EXT-REF-9002',
      customer: shopifyOrder.customer,
      shippingAddress: shopifyOrder.shippingAddress,
      lineItems: shopifyOrder.lineItems,
      status: 'SHIPPED',
      trackingNumber,
      carrier,
      createdAt: now,
      updatedAt: now,
    };
    this.stateService.saveWarehouseOrder(warehouseOrder);

    return {
      scenario: 'TRACKING_MISSING_IN_SHOPIFY',
      orderNumber,
      trackingNumber,
      details: 'Tracking exists in ShipStation and 3PL, but Shopify order remains unfulfilled.',
    };
  }

  private seedStuckOrder() {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    const orderNumber = 'ORD-9003';

    const shopifyOrder: ShopifyOrder = {
      id: 'shp_order_9003',
      orderNumber,
      customer: {
        name: 'Taylor Swift',
        email: 'taylor@example.com',
      },
      shippingAddress: {
        street: '300 Broadway',
        city: 'Nashville',
        state: 'TN',
        postalCode: '37201',
        country: 'US',
      },
      lineItems: [
        { sku: 'PROD-ALBUM-03', name: 'Collector Edition', quantity: 1, price: 89.99 },
      ],
      paymentStatus: 'PAID',
      fulfillmentStatus: 'UNFULFILLED',
      createdAt: threeDaysAgo,
      updatedAt: threeDaysAgo,
    };
    this.stateService.saveShopifyOrder(shopifyOrder);

    const warehouseOrder: WarehouseOrder = {
      id: 'wh_order_9003',
      orderNumber,
      customer: shopifyOrder.customer,
      shippingAddress: shopifyOrder.shippingAddress,
      lineItems: shopifyOrder.lineItems,
      status: 'PENDING_FULFILLMENT',
      createdAt: threeDaysAgo,
      updatedAt: threeDaysAgo,
    };
    this.stateService.saveWarehouseOrder(warehouseOrder);

    return {
      scenario: 'STUCK_ORDER',
      orderNumber,
      details: 'Order stuck in PENDING_FULFILLMENT state for over 48 hours.',
    };
  }

  private seedMissingAt3pl() {
    const now = new Date().toISOString();
    const orderNumber = 'ORD-9004';

    const shopifyOrder: ShopifyOrder = {
      id: 'shp_order_9004',
      orderNumber,
      customer: {
        name: 'Casey Jones',
        email: 'casey@example.com',
      },
      shippingAddress: {
        street: '400 Elm St',
        city: 'Chicago',
        state: 'IL',
        postalCode: '60601',
        country: 'US',
      },
      lineItems: [
        { sku: 'PROD-TOOL-04', name: 'Precision Screwdriver', quantity: 1, price: 19.99 },
      ],
      paymentStatus: 'PAID',
      fulfillmentStatus: 'UNFULFILLED',
      createdAt: now,
      updatedAt: now,
    };
    this.stateService.saveShopifyOrder(shopifyOrder);
    // Notice: NO order created in 3PL!

    return {
      scenario: 'MISSING_AT_3PL',
      orderNumber,
      details: 'Shopify order exists, but completely missing from warehouse / 3PL.',
    };
  }

  private seedShippedAt3plUnfulfilledAtShopify() {
    const now = new Date().toISOString();
    const orderNumber = 'ORD-9005';
    const trackingNumber = 'TRK-FDX-554433';
    const carrier = 'FedEx';

    const shopifyOrder: ShopifyOrder = {
      id: 'shp_order_9005',
      orderNumber,
      customer: {
        name: 'Sam Fisher',
        email: 'sam@example.com',
      },
      shippingAddress: {
        street: '500 Oak St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        country: 'US',
      },
      lineItems: [
        { sku: 'PROD-NIGHTVISION-05', name: 'Optics Goggles', quantity: 1, price: 299.99 },
      ],
      paymentStatus: 'PAID',
      fulfillmentStatus: 'UNFULFILLED',
      createdAt: now,
      updatedAt: now,
    };
    this.stateService.saveShopifyOrder(shopifyOrder);

    const warehouseOrder: WarehouseOrder = {
      id: 'wh_order_9005',
      orderNumber,
      customer: shopifyOrder.customer,
      shippingAddress: shopifyOrder.shippingAddress,
      lineItems: shopifyOrder.lineItems,
      status: 'SHIPPED',
      trackingNumber,
      carrier,
      createdAt: now,
      updatedAt: now,
    };
    this.stateService.saveWarehouseOrder(warehouseOrder);

    return {
      scenario: 'SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY',
      orderNumber,
      trackingNumber,
      details: '3PL shipped order with tracking, but Shopify unfulfilled.',
    };
  }

  private seedInventoryMismatch() {
    const sku = 'SKU-MISMATCH-99';
    this.stateService.setShopifyInventory(sku, 12);
    this.stateService.setWarehouseInventory(sku, 7);

    return {
      scenario: 'INVENTORY_MISMATCH',
      sku,
      shopifyQuantity: 12,
      threePlQuantity: 7,
      details: 'Deliberate inventory count discrepancy seeded.',
    };
  }

  private seedDuplicateRisk() {
    const now = new Date().toISOString();
    const orderNumber = 'ORD-9006';
    const externalReference = 'REF-CONFLICT-9006';

    const warehouseOrder: WarehouseOrder = {
      id: 'wh_order_9006_existing',
      orderNumber,
      externalReference,
      customer: {
        name: 'Morgan Freeman',
        email: 'morgan@example.com',
      },
      shippingAddress: {
        street: '600 Maple Ave',
        city: 'Boston',
        state: 'MA',
        postalCode: '02108',
        country: 'US',
      },
      lineItems: [
        { sku: 'PROD-MICROPHONE-06', name: 'Studio Mic', quantity: 1, price: 149.99 },
      ],
      status: 'PICKING',
      createdAt: now,
      updatedAt: now,
    };
    this.stateService.saveWarehouseOrder(warehouseOrder);

    // Also add a duplicate rule on re-submitting orderNumber or ref
    this.stateService.addFaultRule({
      fault: 'DUPLICATE_ORDER',
      provider: '3pl',
      method: 'POST',
      pathPattern: '/3pl/orders',
      remainingCount: 1,
    });

    return {
      scenario: 'DUPLICATE_RISK',
      orderNumber,
      externalReference,
      details: 'Existing order seeded; re-submission will trigger 409 conflict.',
    };
  }

  private seedInvalidOrderData() {
    this.stateService.addFaultRule({
      fault: 'INVALID_SKU',
      provider: '3pl',
      method: 'POST',
      pathPattern: '/3pl/orders',
      remainingCount: 1,
    });
    return {
      scenario: 'INVALID_ORDER_DATA',
      details: 'Configured 3PL order submission to reject with 422 INVALID_SKU.',
    };
  }

  private seedAmbiguousTimeout() {
    this.stateService.addFaultRule({
      fault: 'COMMIT_THEN_TIMEOUT',
      provider: '3pl',
      method: 'POST',
      pathPattern: '/3pl/orders',
      remainingCount: 1,
      delayMs: 150,
    });
    return {
      scenario: 'AMBIGUOUS_TIMEOUT',
      details: 'Next POST /3pl/orders will commit the order in warehouse, then return timeout error.',
    };
  }
}