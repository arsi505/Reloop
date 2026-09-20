'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { OrderDetailDto } from '@reloop/contracts';
import { apiClient } from '../../lib/api-client';
import { useRealtimeEvent } from '../../context/realtime-context';
import { StatusBadge } from '../ui/StatusBadge';
import { Skeleton } from '../ui/Skeleton';
import { ErrorState } from '../ui/ErrorState';
import {
  ProviderIcon,
  AlertCircleIcon,
  CheckCircleIcon,
  ArrowRightIcon,
} from '../icons/Icons';

interface OrderDetailViewProps {
  orderId: string;
  isDrawer?: boolean;
  onClose?: () => void;
}

export function OrderDetailView({
  orderId,
  isDrawer = false,
}: OrderDetailViewProps) {
  const [detail, setDetail] = useState<OrderDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusCode, setStatusCode] = useState<number | undefined>(undefined);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatusCode(undefined);

    try {
      const data = await apiClient.getOrderDetail(orderId);
      setDetail(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load order detail';
      setError(msg);
      if (msg.includes('401')) setStatusCode(401);
      else if (msg.includes('403')) setStatusCode(403);
      else if (msg.includes('404')) setStatusCode(404);
      else setStatusCode(500);
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  const refetchSilently = useCallback(async () => {
    try {
      const data = await apiClient.getOrderDetail(orderId);
      setDetail(data);
    } catch {
      // Non-blocking background refetch error
    }
  }, [orderId]);

  useRealtimeEvent(
    [
      'exception.created',
      'exception.updated',
      'recovery.updated',
      'recovery.approval_decided',
    ],
    (notification) => {
      const matchesOrder =
        notification.orderId === orderId ||
        (notification.resourceType === 'ORDER' && notification.resourceId === orderId);

      if (matchesOrder) {
        refetchSilently();
      }
    },
    300,
  );

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  if (loading) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto p-2">
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="max-w-4xl mx-auto p-4 space-y-4">
        {!isDrawer && (
          <Link
            href="/orders"
            className="text-xs text-[#71717a] hover:text-[#18181b] flex items-center gap-1.5 font-medium mb-2"
          >
            ← Back to Orders
          </Link>
        )}
        <ErrorState
          statusCode={statusCode}
          message={error || 'Order record not found.'}
          onRetry={fetchDetail}
        />
      </div>
    );
  }

  const hasDiscrepancy = detail.crossSystemDiscrepancy?.hasDiscrepancy;

  return (
    <div className={`space-y-6 max-w-4xl mx-auto ${isDrawer ? 'p-1' : ''}`}>
      {/* Navigation Breadcrumb / Back Link */}
      {!isDrawer && (
        <div className="flex items-center justify-between">
          <Link
            href="/orders"
            className="text-xs text-[#71717a] hover:text-[#18181b] flex items-center gap-1.5 font-medium transition-colors"
          >
            <span>← Back to Orders</span>
          </Link>
          <span className="font-mono text-xs text-[#a1a1aa]">
            Logical ID: {detail.id}
          </span>
        </div>
      )}

      {/* Header Order Summary Card */}
      <div className="p-6 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-bold tracking-tight text-[#18181b]">
              Order #{detail.externalOrderNumber}
            </h2>
            <StatusBadge status={detail.status} size="sm" />
          </div>

          <div className="text-xs text-[#71717a]">
            Last observed: {new Date(detail.lastObservedAt).toLocaleString()}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2 border-t border-[#f4f4f5] text-xs">
          <div>
            <span className="text-[#71717a] block text-[11px]">Total Amount</span>
            <span className="font-bold text-sm text-[#18181b]">
              {detail.currency || 'USD'} {detail.totalAmount || '0.00'}
            </span>
          </div>
          <div>
            <span className="text-[#71717a] block text-[11px]">Order Date</span>
            <span className="text-[#18181b] font-medium">
              {detail.sourceCreatedAt
                ? new Date(detail.sourceCreatedAt).toLocaleDateString()
                : 'N/A'}
            </span>
          </div>
          <div>
            <span className="text-[#71717a] block text-[11px]">Tracking Numbers</span>
            <span className="font-mono text-[#18181b]">
              {detail.trackingNumbers.length > 0
                ? detail.trackingNumbers.join(', ')
                : 'None'}
            </span>
          </div>
          <div>
            <span className="text-[#71717a] block text-[11px]">Active Exceptions</span>
            <span
              className={`font-semibold ${
                detail.relatedExceptions.length > 0 ? 'text-[#b91c1c]' : 'text-[#047857]'
              }`}
            >
              {detail.relatedExceptions.length} active
            </span>
          </div>
        </div>
      </div>

      {/* Cross-System Disagreement Banner (Backend-detected discrepancies only!) */}
      {hasDiscrepancy ? (
        <div className="p-5 rounded-xl bg-[#fffbeb] border border-[#fde68a] text-[#b45309] space-y-3 shadow-subtle">
          <div className="flex items-center gap-2.5 font-semibold text-sm">
            <AlertCircleIcon size={18} className="text-[#d97706] shrink-0" />
            <span>Cross-System State Discrepancy Detected</span>
          </div>
          <p className="text-xs text-[#78350f] leading-relaxed">
            {detail.crossSystemDiscrepancy?.summary ||
              'State difference detected between Shopify and ShipStation.'}
          </p>
          {detail.crossSystemDiscrepancy?.details && (
            <div className="p-3 bg-white/90 rounded-lg border border-[#fde68a] font-mono text-[11px] text-[#52525b] overflow-x-auto">
              <pre>{JSON.stringify(detail.crossSystemDiscrepancy.details, null, 2)}</pre>
            </div>
          )}
        </div>
      ) : (
        <div className="p-4 rounded-xl bg-[#ecfdf5] border border-[#a7f3d0] text-[#047857] text-xs flex items-center gap-2.5 shadow-subtle">
          <CheckCircleIcon size={18} className="text-[#10b981] shrink-0" />
          <span className="font-medium">
            Cross-system state is synchronized with zero detected discrepancies.
          </span>
        </div>
      )}

      {/* Cross-System Facts: Shopify vs ShipStation vs 3PL */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
          Cross-System Factual States
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Shopify State */}
          <div className="p-5 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-[#f4f4f5]">
              <div className="flex items-center gap-2">
                <ProviderIcon provider="SHOPIFY" />
                <span className="font-semibold text-xs text-[#18181b]">
                  Shopify Order State
                </span>
              </div>
              <span className="text-[11px] text-[#71717a]">Commercial Intent</span>
            </div>

            {detail.shopifyState ? (
              <div className="space-y-2.5 text-xs">
                <div className="flex justify-between py-1 border-b border-[#f4f4f5]">
                  <span className="text-[#71717a]">Fulfillment Status</span>
                  <span className="font-semibold text-[#18181b]">
                    {detail.shopifyState.fulfillmentStatus || 'unfulfilled'}
                  </span>
                </div>
                <div className="flex justify-between py-1 border-b border-[#f4f4f5]">
                  <span className="text-[#71717a]">Financial Status</span>
                  <span className="font-medium text-[#18181b]">
                    {detail.shopifyState.financialStatus || 'paid'}
                  </span>
                </div>
                <div className="space-y-1 py-1">
                  <span className="text-[#71717a] block text-[11px]">Tracking Numbers</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {detail.shopifyState.trackingNumbers.length > 0 ? (
                      detail.shopifyState.trackingNumbers.map((t) => (
                        <span
                          key={t}
                          className="px-1.5 py-0.5 rounded bg-[#fbfbfa] border border-[#ececeb] font-mono text-[10px]"
                        >
                          {t}
                        </span>
                      ))
                    ) : (
                      <span className="text-[#a1a1aa] italic text-[11px]">None assigned</span>
                    )}
                  </div>
                </div>
                {detail.shopifyState.lastObservedAt && (
                  <div className="text-[10px] text-[#71717a] pt-1">
                    Observed: {new Date(detail.shopifyState.lastObservedAt).toLocaleString()}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-[#a1a1aa] italic py-3">
                No Shopify record associated with this logical order.
              </p>
            )}
          </div>

          {/* ShipStation State (Preserving Day 16 semantic boundary!) */}
          <div className="p-5 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-[#f4f4f5]">
              <div className="flex items-center gap-2">
                <ProviderIcon provider="SHIPSTATION" />
                <span className="font-semibold text-xs text-[#18181b]">
                  ShipStation State
                </span>
              </div>
              <span className="text-[11px] text-[#71717a]">Shipment & Label Records</span>
            </div>

            {detail.shipstationState ? (
              <div className="space-y-2.5 text-xs">
                <div className="flex justify-between py-1 border-b border-[#f4f4f5]">
                  <span className="text-[#71717a]">Shipment State</span>
                  <span className="font-semibold text-[#18181b]">
                    {detail.shipstationState.shipmentStatus || 'pending'}
                  </span>
                </div>
                <div className="flex justify-between py-1 border-b border-[#f4f4f5]">
                  <span className="text-[#71717a]">Purchased Shipping Labels</span>
                  <span className="font-medium text-[#18181b]">
                    {detail.shipstationState.labelCount} label(s)
                    {detail.shipstationState.voidedLabelCount > 0 &&
                      ` (${detail.shipstationState.voidedLabelCount} voided)`}
                  </span>
                </div>
                <div className="space-y-1 py-1">
                  <span className="text-[#71717a] block text-[11px]">Authoritative Tracking</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {detail.shipstationState.trackingNumbers.length > 0 ? (
                      detail.shipstationState.trackingNumbers.map((t) => (
                        <span
                          key={t}
                          className="px-1.5 py-0.5 rounded bg-[#fbfbfa] border border-[#ececeb] font-mono text-[10px]"
                        >
                          {t}
                        </span>
                      ))
                    ) : (
                      <span className="text-[#a1a1aa] italic text-[11px]">No labels purchased</span>
                    )}
                  </div>
                </div>
                {detail.shipstationState.carrierCodes.length > 0 && (
                  <div className="text-[11px] text-[#71717a]">
                    Carriers: {detail.shipstationState.carrierCodes.join(', ')}
                  </div>
                )}
                {detail.shipstationState.lastObservedAt && (
                  <div className="text-[10px] text-[#71717a] pt-1">
                    Observed: {new Date(detail.shipstationState.lastObservedAt).toLocaleString()}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-[#a1a1aa] italic py-3">
                No ShipStation shipment linked to this order.
              </p>
            )}
          </div>
        </div>

        {/* Generic 3PL State (only if data actually exists!) */}
        {detail.generic3plState && (
          <div className="p-5 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-3">
            <div className="flex items-center gap-2 pb-2 border-b border-[#f4f4f5]">
              <ProviderIcon provider="GENERIC_3PL" />
              <span className="font-semibold text-xs text-[#18181b]">
                Generic 3PL Warehouse State
              </span>
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-1 border-b border-[#f4f4f5]">
                <span className="text-[#71717a]">Warehouse Status</span>
                <span className="font-semibold text-[#18181b]">
                  {detail.generic3plState.warehouseStatus || 'pending'}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-[#71717a]">Tracking Number</span>
                <span className="font-mono text-[#18181b]">
                  {detail.generic3plState.trackingNumber || 'None'}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Related Exceptions Section */}
      <div className="p-5 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
          Related Exceptions ({detail.relatedExceptions.length})
        </h3>

        {detail.relatedExceptions.length > 0 ? (
          <div className="space-y-2 pt-1">
            {detail.relatedExceptions.map((exc) => (
              <Link
                key={exc.id}
                href={`/exceptions/${exc.id}`}
                className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] hover:border-[#d4d4d8] flex items-center justify-between text-xs transition-colors group block"
              >
                <div>
                  <p className="font-medium text-[#18181b] group-hover:text-[#f95721] transition-colors">
                    {exc.summary}
                  </p>
                  <p className="text-[10px] text-[#71717a]">
                    Detected {new Date(exc.detectedAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={exc.status} size="sm" />
                  <ArrowRightIcon size={12} className="text-[#71717a] group-hover:text-[#f95721]" />
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-xs text-[#71717a] italic py-2">
            No active or historical exceptions associated with this order.
          </p>
        )}
      </div>

      {/* External References List */}
      <div className="p-5 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
          External Provider Identifiers
        </h3>

        <div className="space-y-1.5 font-mono text-[11px]">
          {detail.externalReferences.map((ref) => (
            <div
              key={ref.id}
              className="flex items-center justify-between p-2.5 rounded-lg bg-[#fbfbfa] border border-[#ececeb]"
            >
              <div className="flex items-center gap-2.5">
                <ProviderIcon provider={ref.provider} />
                <span className="text-[#71717a]">{ref.resourceType}:</span>
                <span className="text-[#18181b] font-medium">{ref.externalId}</span>
              </div>
              <span className="text-[#a1a1aa] text-[10px]">
                {new Date(ref.createdAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
