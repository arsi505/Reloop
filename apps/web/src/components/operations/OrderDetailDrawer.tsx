'use client';

import React, { useEffect, useState } from 'react';
import { OrderDetailDto } from '@reloop/contracts';
import { apiClient } from '../../lib/api-client';
import { StatusBadge } from '../ui/StatusBadge';
import { CloseIcon, ProviderIcon, AlertCircleIcon, CheckCircleIcon } from '../icons/Icons';

interface OrderDetailDrawerProps {
  orderId: string | null;
  onClose: () => void;
  onViewException?: (exceptionId: string) => void;
}

export function OrderDetailDrawer({
  orderId,
  onClose,
  onViewException,
}: OrderDetailDrawerProps) {
  const [detail, setDetail] = useState<OrderDetailDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orderId) {
      setDetail(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);

    apiClient
      .getOrderDetail(orderId)
      .then((data) => {
        if (isMounted) setDetail(data);
      })
      .catch((err: unknown) => {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to load order detail');
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [orderId]);

  if (!orderId) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/20 backdrop-blur-sm transition-opacity animate-fadeIn"
        onClick={onClose}
      />

      {/* Drawer Body */}
      <div className="relative w-full max-w-2xl bg-white h-full shadow-2xl border-l border-[#ececeb] flex flex-col z-10 animate-slideLeft">
        {/* Header */}
        <div className="p-5 border-b border-[#ececeb] flex items-center justify-between bg-[#fbfbfa]">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-medium text-[#71717a]">
                Order Reference
              </span>
              {detail && <StatusBadge status={detail.status} size="sm" />}
            </div>
            <h2 className="text-base font-semibold text-[#18181b]">
              {detail ? `Order #${detail.externalOrderNumber}` : 'Loading Order...'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#71717a] hover:text-[#18181b] hover:bg-[#ececeb] transition-colors"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6 text-xs">
          {loading && (
            <div className="py-12 flex flex-col items-center justify-center text-[#71717a] space-y-3">
              <div className="w-5 h-5 border-2 border-[#f95721] border-t-transparent rounded-full animate-spin" />
              <span>Fetching cross-system factual order state...</span>
            </div>
          )}

          {error && (
            <div className="p-4 rounded-lg bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c]">
              <p className="font-semibold">Unable to load order</p>
              <p className="mt-1">{error}</p>
            </div>
          )}

          {detail && (
            <>
              {/* Discrepancy Status Card */}
              {detail.crossSystemDiscrepancy?.hasDiscrepancy ? (
                <div className="p-4 rounded-lg bg-[#fffbeb] border border-[#fde68a] text-[#b45309] space-y-2">
                  <div className="flex items-center gap-2 font-semibold">
                    <AlertCircleIcon size={16} className="text-[#d97706]" />
                    <span>Cross-System Discrepancy Detected</span>
                  </div>
                  <p className="text-xs text-[#78350f]">
                    {detail.crossSystemDiscrepancy.summary ||
                      'State difference detected between Shopify and ShipStation.'}
                  </p>
                  {detail.crossSystemDiscrepancy.details && (
                    <div className="p-2.5 bg-white/80 rounded border border-[#fde68a] text-[11px] font-mono">
                      <pre>{JSON.stringify(detail.crossSystemDiscrepancy.details, null, 2)}</pre>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-3 rounded-lg bg-[#ecfdf5] border border-[#a7f3d0] text-[#047857] flex items-center gap-2">
                  <CheckCircleIcon size={16} className="text-[#10b981]" />
                  <span className="font-medium">
                    All connected systems are in sync with zero discrepancies.
                  </span>
                </div>
              )}

              {/* Cross-System State Comparison Grid */}
              <div className="space-y-3">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
                  Cross-System State Comparison
                </span>

                <div className="grid grid-cols-2 gap-4">
                  {/* Shopify Side */}
                  <div className="p-4 rounded-lg bg-[#fbfbfa] border border-[#ececeb] space-y-3">
                    <div className="flex items-center justify-between">
                      <ProviderIcon provider="SHOPIFY" />
                      <span className="text-[11px] text-[#71717a]">Order Intent</span>
                    </div>

                    {detail.shopifyState ? (
                      <div className="space-y-2 pt-1 text-xs">
                        <div>
                          <span className="text-[#71717a] block text-[11px]">Fulfillment Status</span>
                          <span className="font-semibold text-[#18181b]">
                            {detail.shopifyState.fulfillmentStatus || 'unfulfilled'}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#71717a] block text-[11px]">Financial Status</span>
                          <span className="font-medium text-[#18181b]">
                            {detail.shopifyState.financialStatus || 'paid'}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#71717a] block text-[11px]">Tracking Numbers</span>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {detail.shopifyState.trackingNumbers.length > 0 ? (
                              detail.shopifyState.trackingNumbers.map((t) => (
                                <span
                                  key={t}
                                  className="px-1.5 py-0.5 rounded bg-white border border-[#ececeb] font-mono text-[10px]"
                                >
                                  {t}
                                </span>
                              ))
                            ) : (
                              <span className="text-[#a1a1aa] italic text-[11px]">None assigned</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="text-[#a1a1aa] italic text-xs">No Shopify record linked.</p>
                    )}
                  </div>

                  {/* ShipStation Side */}
                  <div className="p-4 rounded-lg bg-[#fbfbfa] border border-[#ececeb] space-y-3">
                    <div className="flex items-center justify-between">
                      <ProviderIcon provider="SHIPSTATION" />
                      <span className="text-[11px] text-[#71717a]">Physical Execution</span>
                    </div>

                    {detail.shipstationState ? (
                      <div className="space-y-2 pt-1 text-xs">
                        <div>
                          <span className="text-[#71717a] block text-[11px]">Shipment Status</span>
                          <span className="font-semibold text-[#18181b]">
                            {detail.shipstationState.shipmentStatus || 'pending'}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#71717a] block text-[11px]">Authoritative Labels</span>
                          <span className="font-medium text-[#18181b]">
                            {detail.shipstationState.labelCount} label(s)
                            {detail.shipstationState.voidedLabelCount > 0 &&
                              ` (${detail.shipstationState.voidedLabelCount} voided)`}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#71717a] block text-[11px]">Authoritative Tracking</span>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {detail.shipstationState.trackingNumbers.length > 0 ? (
                              detail.shipstationState.trackingNumbers.map((t) => (
                                <span
                                  key={t}
                                  className="px-1.5 py-0.5 rounded bg-white border border-[#ececeb] font-mono text-[10px]"
                                >
                                  {t}
                                </span>
                              ))
                            ) : (
                              <span className="text-[#a1a1aa] italic text-[11px]">No labels purchased</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="text-[#a1a1aa] italic text-xs">No ShipStation record linked.</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Related Exceptions */}
              <div className="p-4 rounded-lg bg-white border border-[#ececeb] space-y-3">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
                  Related Exceptions ({detail.relatedExceptions.length})
                </span>

                {detail.relatedExceptions.length > 0 ? (
                  <div className="space-y-2">
                    {detail.relatedExceptions.map((exc) => (
                      <div
                        key={exc.id}
                        className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] flex items-center justify-between"
                      >
                        <div>
                          <p className="font-medium text-[#18181b]">{exc.summary}</p>
                          <p className="text-[10px] text-[#71717a]">
                            Detected {new Date(exc.detectedAt).toLocaleString()}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={exc.status} size="sm" />
                          {onViewException && (
                            <button
                              onClick={() => onViewException(exc.id)}
                              className="text-xs text-[#f95721] hover:underline font-medium ml-2"
                            >
                              Inspect
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[#71717a] italic">No active or historical exceptions for this order.</p>
                )}
              </div>

              {/* External Provider Identifiers */}
              <div className="p-4 rounded-lg bg-white border border-[#ececeb] space-y-3">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
                  External System References
                </span>
                <div className="space-y-1.5 font-mono text-[11px]">
                  {detail.externalReferences.map((ref) => (
                    <div
                      key={ref.id}
                      className="flex items-center justify-between p-2 rounded bg-[#fbfbfa] border border-[#ececeb]"
                    >
                      <div className="flex items-center gap-2">
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
