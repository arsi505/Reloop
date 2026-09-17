import { SimulatorStateService } from './simulator-state.service';
import { ShopifyOrder, ShipStationShipment, WarehouseOrder } from '@reloop/connector-simulator';

describe('SimulatorStateService', () => {
  let service: SimulatorStateService;

  beforeEach(() => {
    service = new SimulatorStateService();
  });

  describe('Shopify Orders & Inventory', () => {
    it('saves and retrieves shopify orders by id and orderNumber', () => {
      const order: ShopifyOrder = {
        id: 'shp_1',
        orderNumber: 'ORD-100',
        customer: { name: 'Alice', email: 'alice@example.com' },
        shippingAddress: { street: '1 Main', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item', quantity: 1, price: 10 }],
        paymentStatus: 'PAID',
        fulfillmentStatus: 'UNFULFILLED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      service.saveShopifyOrder(order);
      expect(service.getShopifyOrder('shp_1')).toEqual(order);
      expect(service.getShopifyOrderByNumber('ORD-100')).toEqual(order);
      expect(service.listShopifyOrders()).toHaveLength(1);
    });

    it('manages shopify inventory counts independently', () => {
      service.setShopifyInventory('SKU-1', 25);
      expect(service.getShopifyInventory('SKU-1')).toBe(25);
      expect(service.getShopifyInventory('NONEXISTENT')).toBeUndefined();
    });
  });

  describe('ShipStation Shipments', () => {
    it('saves and retrieves shipments by id and orderNumber', () => {
      const shipment: ShipStationShipment = {
        id: 'ship_1',
        orderNumber: 'ORD-100',
        carrier: 'UPS',
        trackingNumber: 'TRK-100',
        status: 'LABEL_CREATED',
        shippingAddress: { street: '1 Main', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      service.saveShipment(shipment);
      expect(service.getShipment('ship_1')).toEqual(shipment);
      expect(service.getShipmentByOrderNumber('ORD-100')).toEqual(shipment);
      expect(service.listShipments()).toHaveLength(1);
    });
  });

  describe('3PL Warehouse Orders & Inventory', () => {
    it('saves and retrieves warehouse orders by id, number, and reference', () => {
      const order: WarehouseOrder = {
        id: 'wh_1',
        orderNumber: 'ORD-100',
        externalReference: 'REF-100',
        customer: { name: 'Alice', email: 'alice@example.com' },
        shippingAddress: { street: '1 Main', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item', quantity: 1, price: 10 }],
        status: 'RECEIVED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      service.saveWarehouseOrder(order);
      expect(service.getWarehouseOrder('wh_1')).toEqual(order);
      expect(service.getWarehouseOrderByNumber('ORD-100')).toEqual(order);
      expect(service.getWarehouseOrderByRef('REF-100')).toEqual(order);
      expect(service.listWarehouseOrders()).toHaveLength(1);
    });

    it('manages 3PL inventory counts independently', () => {
      service.setWarehouseInventory('SKU-1', 14);
      expect(service.getWarehouseInventory('SKU-1')).toBe(14);
      expect(service.getWarehouseInventory('NONEXISTENT')).toBeUndefined();
    });
  });

  describe('Fault Rules & Isolation Reset', () => {
    it('matches and decrements fault rules', () => {
      service.addFaultRule({
        fault: 'RETURN_503',
        provider: '3pl',
        method: 'POST',
        pathPattern: '/orders',
        remainingCount: 2,
      });

      const match1 = service.getMatchingFault('3pl', 'POST', '/3pl/orders');
      expect(match1).toBeDefined();
      expect(match1?.fault).toBe('RETURN_503');
      expect(service.faultRules[0].remainingCount).toBe(1);

      const match2 = service.getMatchingFault('3pl', 'POST', '/3pl/orders');
      expect(match2).toBeDefined();
      expect(service.faultRules).toHaveLength(0); // removed when count reached 0

      const match3 = service.getMatchingFault('3pl', 'POST', '/3pl/orders');
      expect(match3).toBeUndefined();
    });

    it('resets in-memory state completely without affecting external infrastructure', () => {
      service.setShopifyInventory('SKU-TEST', 10);
      service.setWarehouseInventory('SKU-TEST', 5);
      service.addFaultRule({ fault: 'RETURN_429', remainingCount: 1 });

      expect(service.getShopifyInventory('SKU-TEST')).toBe(10);
      service.reset();

      expect(service.getShopifyInventory('SKU-TEST')).toBeUndefined();
      expect(service.getWarehouseInventory('SKU-TEST')).toBeUndefined();
      expect(service.faultRules).toHaveLength(0);
    });
  });
});