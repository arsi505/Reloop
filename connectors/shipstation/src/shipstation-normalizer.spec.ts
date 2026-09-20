import {
  mapShipStationStatus,
  normalizeOrderNumber,
  normalizeShipStationShipment,
  normalizeShipStationLabel,
} from './shipstation-normalizer';
import { ShipStationRawShipment, ShipStationRawLabel } from './shipstation-client';

describe('ShipStation Normalizer', () => {
  describe('mapShipStationStatus', () => {
    it('CRITICAL: maps label_purchased to LABEL_CREATED, strictly never SHIPPED', () => {
      const status = mapShipStationStatus('label_purchased');
      expect(status).toBe('LABEL_CREATED');
      expect(status).not.toBe('SHIPPED');
    });

    it('maps pending, processing, cancelled correctly', () => {
      expect(mapShipStationStatus('pending')).toBe('PENDING');
      expect(mapShipStationStatus('processing')).toBe('PROCESSING');
      expect(mapShipStationStatus('cancelled')).toBe('CANCELLED');
      expect(mapShipStationStatus('voided')).toBe('CANCELLED');
      expect(mapShipStationStatus('unknown_status')).toBe('UNKNOWN');
      expect(mapShipStationStatus(null)).toBe('UNKNOWN');
    });
  });

  describe('normalizeOrderNumber', () => {
    it('strips leading hash and whitespace', () => {
      expect(normalizeOrderNumber('#1042')).toBe('1042');
      expect(normalizeOrderNumber('  #1042  ')).toBe('1042');
      expect(normalizeOrderNumber('1042')).toBe('1042');
      expect(normalizeOrderNumber('')).toBe('');
      expect(normalizeOrderNumber(null)).toBe('');
    });
  });

  describe('normalizeShipStationShipment', () => {
    it('normalizes shipment fields and strictly excludes PII (tracking belongs to Label)', () => {
      const rawPayload: ShipStationRawShipment = {
        shipment_id: 'ss-554433',
        shipment_number: 'SHIP-554433',
        external_order_id: '#1099',
        order_number: 'ORDER-1099',
        shipment_status: 'label_purchased',
        carrier_code: 'USPS',
        service_code: 'USPS_PRIORITY',
        ship_date: '2026-09-20T10:00:00Z',
        created_at: '2026-09-20T08:00:00Z',
        modified_at: '2026-09-20T09:30:00Z',
        // PII fields that might be present in raw provider payload:
        customer_name: 'John Doe',
        recipient_name: 'Jane Doe',
        phone: '+15551234567',
        email: 'customer@example.com',
        street_address: '123 Main Street',
        city: 'Metropolis',
        postal_code: '12345',
      };

      const normalized = normalizeShipStationShipment(rawPayload);

      expect(normalized.shipmentId).toBe('ss-554433');
      expect(normalized.shipmentNumber).toBe('SHIP-554433');
      expect(normalized.orderNumber).toBe('1099'); // leading # stripped
      expect(normalized.externalOrderId).toBe('#1099');
      expect(normalized.status).toBe('LABEL_CREATED'); // label_purchased -> LABEL_CREATED
      expect(normalized.carrier).toBe('usps');
      expect(normalized.service).toBe('usps_priority');
      expect(normalized.shipDate).toEqual(new Date('2026-09-20T10:00:00Z'));

      // Verify PII minimization: none of these keys exist in the normalized object
      const normalizedRecord = normalized as unknown as Record<string, unknown>;
      expect(normalizedRecord.customer_name).toBeUndefined();
      expect(normalizedRecord.recipient_name).toBeUndefined();
      expect(normalizedRecord.phone).toBeUndefined();
      expect(normalizedRecord.email).toBeUndefined();
      expect(normalizedRecord.street_address).toBeUndefined();
      expect(normalizedRecord.customerName).toBeUndefined();
      expect(normalizedRecord.recipientName).toBeUndefined();
      expect(normalizedRecord.address).toBeUndefined();
    });
  });

  describe('normalizeShipStationLabel', () => {
    it('normalizes label fields and extracts authoritative tracking', () => {
      const rawLabel: ShipStationRawLabel = {
        label_id: 'lbl-100',
        shipment_id: 'ss-554433',
        external_shipment_id: 'shp_ext_123',
        tracking_number: '9400111899562537624123',
        carrier_code: 'USPS',
        service_code: 'usps_priority_mail',
        status: 'completed',
        voided: false,
        tracking_status: 'in_transit',
        created_at: '2026-09-20T09:00:00Z',
      };

      const normalized = normalizeShipStationLabel(rawLabel);

      expect(normalized.labelId).toBe('lbl-100');
      expect(normalized.shipmentId).toBe('ss-554433');
      expect(normalized.externalShipmentId).toBe('shp_ext_123');
      expect(normalized.trackingNumber).toBe('9400111899562537624123');
      expect(normalized.carrierCode).toBe('usps');
      expect(normalized.serviceCode).toBe('usps_priority_mail');
      expect(normalized.status).toBe('completed');
      expect(normalized.voided).toBe(false);
      expect(normalized.trackingStatus).toBe('in_transit');
    });

    it('extracts tracking number from packages array fallback if top-level missing', () => {
      const rawLabel: ShipStationRawLabel = {
        label_id: 'lbl-101',
        shipment_id: 'ss-554433',
        status: 'completed',
        voided: false,
        packages: [
          { package_id: 'pkg-1', tracking_number: '9400999999999999999999' },
        ],
      };

      const normalized = normalizeShipStationLabel(rawLabel);
      expect(normalized.trackingNumber).toBe('9400999999999999999999');
    });

    it('detects voided labels correctly via flag or status', () => {
      const voidedByFlag = normalizeShipStationLabel({
        label_id: 'lbl-102',
        shipment_id: 'ss-1',
        voided: true,
        status: 'completed',
      });
      expect(voidedByFlag.voided).toBe(true);

      const voidedByStatus = normalizeShipStationLabel({
        label_id: 'lbl-103',
        shipment_id: 'ss-2',
        voided: false,
        status: 'voided',
      });
      expect(voidedByStatus.voided).toBe(true);

      const voidedByTrackingStatus = normalizeShipStationLabel({
        label_id: 'lbl-104',
        shipment_id: 'ss-3',
        voided: false,
        tracking_status: 'VOIDED',
      });
      expect(voidedByTrackingStatus.voided).toBe(true);
    });
  });
});
