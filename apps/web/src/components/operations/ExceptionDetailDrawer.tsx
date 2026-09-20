'use client';

import React, { useEffect, useState } from 'react';
import { ExceptionDetailDto } from '@reloop/contracts';
import { apiClient } from '../../lib/api-client';
import { StatusBadge } from '../ui/StatusBadge';
import { CloseIcon, ProviderIcon, ClockIcon } from '../icons/Icons';

interface ExceptionDetailDrawerProps {
  exceptionId: string | null;
  onClose: () => void;
  onViewOrder?: (orderId: string) => void;
}

export function ExceptionDetailDrawer({
  exceptionId,
  onClose,
  onViewOrder,
}: ExceptionDetailDrawerProps) {
  const [detail, setDetail] = useState<ExceptionDetailDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!exceptionId) {
      setDetail(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);

    apiClient
      .getExceptionDetail(exceptionId)
      .then((data) => {
        if (isMounted) setDetail(data);
      })
      .catch((err: unknown) => {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to load exception detail');
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [exceptionId]);

  if (!exceptionId) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/20 backdrop-blur-sm transition-opacity animate-fadeIn"
        onClick={onClose}
      />

      {/* Drawer Body */}
      <div className="relative w-full max-w-xl bg-white h-full shadow-2xl border-l border-[#ececeb] flex flex-col z-10 animate-slideLeft">
        {/* Header */}
        <div className="p-5 border-b border-[#ececeb] flex items-center justify-between bg-[#fbfbfa]">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-medium text-[#71717a]">
                Exception ID: {exceptionId.slice(0, 8)}...
              </span>
              {detail && <StatusBadge status={detail.status} size="sm" />}
              {detail && <StatusBadge status={detail.recoveryLevel} size="sm" />}
            </div>
            <h2 className="text-base font-semibold text-[#18181b]">
              {detail ? detail.type.replace(/_/g, ' ') : 'Loading Exception...'}
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
              <span>Fetching sanitized exception detail...</span>
            </div>
          )}

          {error && (
            <div className="p-4 rounded-lg bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c]">
              <p className="font-semibold">Unable to load exception</p>
              <p className="mt-1">{error}</p>
            </div>
          )}

          {detail && (
            <>
              {/* Summary Box */}
              <div className="p-4 rounded-lg bg-[#fbfbfa] border border-[#ececeb] space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
                  Incident Summary
                </span>
                <p className="text-[13px] text-[#18181b] font-medium leading-relaxed">
                  {detail.summary}
                </p>
                <div className="pt-2 flex items-center gap-4 text-[11px] text-[#71717a]">
                  <span className="flex items-center gap-1">
                    <ClockIcon size={12} />
                    Detected: {new Date(detail.detectedAt).toLocaleString()}
                  </span>
                  {detail.resolvedAt && (
                    <span>Resolved: {new Date(detail.resolvedAt).toLocaleString()}</span>
                  )}
                </div>
              </div>

              {/* Associated Order */}
              <div className="p-4 rounded-lg bg-white border border-[#ececeb] space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
                    Associated Order
                  </span>
                  {detail.order && onViewOrder && (
                    <button
                      onClick={() => onViewOrder(detail.order!.id)}
                      className="text-[#f95721] hover:underline font-medium text-[11px]"
                    >
                      View Order Cross-System State →
                    </button>
                  )}
                </div>

                {detail.order ? (
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div>
                      <span className="text-[#71717a] block">Order Number</span>
                      <span className="font-semibold text-[#18181b]">
                        #{detail.order.orderNumber}
                      </span>
                    </div>
                    <div>
                      <span className="text-[#71717a] block">Order Status</span>
                      <span className="font-medium text-[#18181b]">
                        {detail.order.status}
                      </span>
                    </div>
                    <div>
                      <span className="text-[#71717a] block">Total Amount</span>
                      <span className="font-medium text-[#18181b]">
                        {detail.order.currency || 'USD'} {detail.order.totalAmount || '0.00'}
                      </span>
                    </div>
                    <div>
                      <span className="text-[#71717a] block">Created At</span>
                      <span className="text-[#71717a]">
                        {detail.order.sourceCreatedAt
                          ? new Date(detail.order.sourceCreatedAt).toLocaleDateString()
                          : 'N/A'}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-[#71717a] italic">No logical order mapped to this incident.</p>
                )}
              </div>

              {/* Provider Integration */}
              {detail.integration && (
                <div className="p-4 rounded-lg bg-white border border-[#ececeb] space-y-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
                    Source Integration
                  </span>
                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-2">
                      <ProviderIcon provider={detail.integration.provider} />
                      <span className="font-medium text-[#18181b]">
                        {detail.integration.name}
                      </span>
                    </div>
                    <StatusBadge status={detail.integration.status} size="sm" />
                  </div>
                </div>
              )}

              {/* Workflow & Recovery Steps */}
              {detail.workflowSteps && detail.workflowSteps.length > 0 && (
                <div className="p-4 rounded-lg bg-white border border-[#ececeb] space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
                      Recovery Execution Steps ({detail.workflowSteps.length})
                    </span>
                    {detail.workflow && (
                      <StatusBadge status={detail.workflow.status} size="sm" />
                    )}
                  </div>
                  <div className="space-y-2 pt-1">
                    {detail.workflowSteps.map((step) => (
                      <div
                        key={step.id}
                        className="p-2.5 rounded bg-[#fbfbfa] border border-[#ececeb] flex items-center justify-between"
                      >
                        <div>
                          <p className="font-medium text-[#18181b]">{step.name}</p>
                          <p className="text-[10px] text-[#71717a] font-mono">{step.key}</p>
                        </div>
                        <StatusBadge status={step.status} size="sm" />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Sanitized Evidence Inspection */}
              <div className="space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
                  Sanitized Factual Evidence (Zero PII)
                </span>
                <div className="p-3 bg-[#fbfbfa] border border-[#ececeb] rounded-lg overflow-x-auto">
                  <pre className="font-mono text-[11px] text-[#52525b] leading-tight">
                    {JSON.stringify(detail.sanitizedEvidence, null, 2)}
                  </pre>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
