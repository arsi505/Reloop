'use client';

import React, { useEffect, useState } from 'react';
import { RecoveryDetailDto } from '@reloop/contracts';
import { apiClient } from '../../lib/api-client';
import { StatusBadge } from '../ui/StatusBadge';
import { CloseIcon } from '../icons/Icons';

interface RecoveryDetailDrawerProps {
  workflowId: string | null;
  onClose: () => void;
  onViewOrder?: (orderId: string) => void;
}

export function RecoveryDetailDrawer({
  workflowId,
  onClose,
  onViewOrder,
}: RecoveryDetailDrawerProps) {
  const [detail, setDetail] = useState<RecoveryDetailDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowId) {
      setDetail(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);

    apiClient
      .getRecoveryDetail(workflowId)
      .then((data) => {
        if (isMounted) setDetail(data);
      })
      .catch((err: unknown) => {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to load recovery detail');
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [workflowId]);

  if (!workflowId) return null;

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
                Flight Recorder
              </span>
              {detail && <StatusBadge status={detail.status} size="sm" />}
            </div>
            <h2 className="text-base font-semibold text-[#18181b]">
              {detail ? `Workflow: ${detail.templateKey} (v${detail.templateVersion})` : 'Loading Flight Recorder...'}
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
              <span>Fetching chronological audit timeline...</span>
            </div>
          )}

          {error && (
            <div className="p-4 rounded-lg bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c]">
              <p className="font-semibold">Unable to load recovery detail</p>
              <p className="mt-1">{error}</p>
            </div>
          )}

          {detail && (
            <>
              {/* Incident Header */}
              <div className="p-4 rounded-lg bg-[#fbfbfa] border border-[#ececeb] space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
                  Recovery Target
                </span>
                <p className="text-[13px] text-[#18181b] font-medium leading-relaxed">
                  {detail.caseSummary}
                </p>
                <div className="pt-2 flex items-center justify-between text-[11px] text-[#71717a]">
                  <span>Type: {detail.caseType.replace(/_/g, ' ')}</span>
                  {detail.order && onViewOrder && (
                    <button
                      onClick={() => onViewOrder(detail.order!.id)}
                      className="text-[#f95721] hover:underline font-medium"
                    >
                      Order #{detail.order.orderNumber} →
                    </button>
                  )}
                </div>
              </div>

              {/* Factual Chronological Timeline */}
              <div className="space-y-3">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
                  Factual Audit Timeline ({detail.timeline.length} events)
                </span>

                <div className="relative pl-6 space-y-4 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-[#ececeb]">
                  {detail.timeline.map((event) => (
                    <div key={event.id} className="relative group">
                      {/* Timeline Dot */}
                      <div className="absolute -left-6 top-1 w-4 h-4 rounded-full bg-white border-2 border-[#f95721] flex items-center justify-center" />

                      <div className="p-3 bg-[#fbfbfa] border border-[#ececeb] rounded-lg space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-[#18181b] text-xs">
                            {event.eventType}
                          </span>
                          <span className="text-[10px] text-[#71717a] font-mono">
                            {new Date(event.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <p className="text-[11px] text-[#52525b]">{event.description}</p>
                        <div className="pt-1 flex items-center gap-3 text-[10px] text-[#71717a]">
                          <span>System: <code className="font-mono text-[#18181b]">{event.system}</code></span>
                          {event.actor && (
                            <span>Actor: <strong className="text-[#18181b]">{event.actor.name}</strong></span>
                          )}
                        </div>
                      </div>
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
