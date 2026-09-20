import { ShipStationRawShipment, ShipStationRawLabel } from './shipstation-client';

export type NormalizedShipmentStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'LABEL_CREATED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface NormalizedShipStationLabel {
  labelId: string;
  shipmentId: string;
  externalShipmentId?: string;
  trackingNumber: string;
  carrierCode?: string;
  serviceCode?: string;
  status: string;
  voided: boolean;
  trackingStatus?: string;
  createdAt: Date;
}

export interface NormalizedShipStationShipment {
  shipmentId: string;
  shipmentNumber?: string;
  externalShipmentId?: string;
  orderNumber: string;
  externalOrderId?: string;
  status: NormalizedShipmentStatus;
  carrier?: string;
  service?: string;
  shipDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Maps ShipStation shipment_status to Reloop normalized shipment status.
 *
 * CRITICAL SEMANTIC INVARIANT:
 * 'label_purchased' means a shipping label has been generated, NOT that the parcel
 * has physically been picked up by the carrier or shipped. Therefore, 'label_purchased'
 * maps to 'LABEL_CREATED', strictly avoiding 'SHIPPED'.
 */
export function mapShipStationStatus(rawStatus?: string | null): NormalizedShipmentStatus {
  if (!rawStatus) return 'UNKNOWN';

  const normalized = rawStatus.trim().toLowerCase();
  switch (normalized) {
    case 'pending':
      return 'PENDING';
    case 'processing':
      return 'PROCESSING';
    case 'label_purchased':
      return 'LABEL_CREATED';
    case 'cancelled':
    case 'canceled':
    case 'voided':
      return 'CANCELLED';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Strips leading hash and whitespace from order numbers to normalize cross-system comparisons.
 * E.g., "#1001" -> "1001".
 */
export function normalizeOrderNumber(rawOrderNumber?: string | null): string {
  if (!rawOrderNumber) return '';
  return rawOrderNumber.trim().replace(/^#/, '').trim();
}

/**
 * Normalizes a raw ShipStation shipment payload into Reloop's normalized shipment entity.
 *
 * Enforces PII minimization:
 * Completely discards recipient name, company, phone, email, street addresses,
 * and only retains operational shipping metadata (order reference, tracking, status, timestamps).
 */
export function normalizeShipStationShipment(
  raw: ShipStationRawShipment,
): NormalizedShipStationShipment {
  const shipmentId = String(raw.shipment_id);
  const rawOrderRef = (raw.external_order_id || raw.order_number || '') as string;
  const orderNumber = normalizeOrderNumber(rawOrderRef) || shipmentId;
  const status = mapShipStationStatus(raw.shipment_status);

  let shipDate: Date | undefined;
  if (raw.ship_date) {
    const parsed = new Date(raw.ship_date);
    if (!isNaN(parsed.getTime())) {
      shipDate = parsed;
    }
  }

  const createdAt = raw.created_at ? new Date(raw.created_at) : new Date();
  const updatedAt = raw.modified_at ? new Date(raw.modified_at) : createdAt;

  return {
    shipmentId,
    shipmentNumber: raw.shipment_number ? String(raw.shipment_number) : undefined,
    externalShipmentId: raw.external_shipment_id ? String(raw.external_shipment_id) : undefined,
    orderNumber,
    externalOrderId: raw.external_order_id ? String(raw.external_order_id) : undefined,
    status,
    carrier: raw.carrier_code ? String(raw.carrier_code).toLowerCase() : undefined,
    service: raw.service_code ? String(raw.service_code).toLowerCase() : undefined,
    shipDate,
    createdAt: isNaN(createdAt.getTime()) ? new Date() : createdAt,
    updatedAt: isNaN(updatedAt.getTime()) ? new Date() : updatedAt,
  };
}

/**
 * Normalizes a raw ShipStation Label payload into Reloop's normalized label entity.
 *
 * CRITICAL SEMANTIC INVARIANT:
 * Authoritative tracking numbers originate on Label resources in ShipStation V2.
 * Labels must be inspected for voided status; a voided label cannot provide
 * valid active tracking evidence.
 *
 * Enforces PII minimization: Discards label images, download URLs, recipient addresses.
 */
export function normalizeShipStationLabel(raw: ShipStationRawLabel): NormalizedShipStationLabel {
  const labelId = String(raw.label_id);
  const shipmentId = String(raw.shipment_id);
  const externalShipmentId = raw.external_shipment_id ? String(raw.external_shipment_id) : undefined;

  // Extract tracking number from label or packages array
  let trackingNumber = raw.tracking_number ? String(raw.tracking_number).trim() : '';
  if (!trackingNumber && raw.packages && raw.packages.length > 0) {
    const pkgTracking = raw.packages[0]?.tracking_number;
    if (pkgTracking) {
      trackingNumber = String(pkgTracking).trim();
    }
  }

  const isVoided =
    raw.voided === true ||
    String(raw.status || '').toLowerCase() === 'voided' ||
    String(raw.tracking_status || '').toLowerCase() === 'voided';

  const createdAt = raw.created_at ? new Date(raw.created_at) : new Date();

  return {
    labelId,
    shipmentId,
    externalShipmentId,
    trackingNumber,
    carrierCode: (raw.carrier_code || raw.carrier_id) ? String(raw.carrier_code || raw.carrier_id).toLowerCase() : undefined,
    serviceCode: raw.service_code ? String(raw.service_code).toLowerCase() : undefined,
    status: String(raw.status || 'unknown').toLowerCase(),
    voided: isVoided,
    trackingStatus: raw.tracking_status ? String(raw.tracking_status) : undefined,
    createdAt: isNaN(createdAt.getTime()) ? new Date() : createdAt,
  };
}
