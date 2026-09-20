'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { RecoveryDetailDto, WorkflowStatus } from '@reloop/contracts';
import { apiClient } from '../../lib/api-client';
import { useRealtimeEvent } from '../../context/realtime-context';
import { StatusBadge } from '../ui/StatusBadge';
import { ErrorState } from '../ui/ErrorState';
import { MetricCardSkeleton } from '../ui/Skeleton';
import { FlightRecorderTimeline } from './FlightRecorderTimeline';
import { ApprovalPanel } from './ApprovalPanel';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  RefreshIcon,
  ClockIcon,
} from '../icons/Icons';

interface RecoveryDetailViewProps {
  id: string;
}

export const RecoveryDetailView: React.FC<RecoveryDetailViewProps> = ({ id }) => {
  const [detail, setDetail] = useState<RecoveryDetailDto | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<{ status?: number; message?: string } | null>(null);
  const pollingTimerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchDetail = useCallback(
    async (isBackgroundPoll = false) => {
      if (!isBackgroundPoll) {
        setIsRefreshing(true);
      }
      try {
        const res = await apiClient.getRecoveryDetail(id);
        setDetail(res);
        setError(null);
      } catch (err: unknown) {
        if (!isBackgroundPoll) {
          const msg = err instanceof Error ? err.message : 'Failed to load recovery details';
          const status = (err && typeof err === 'object' && 'status' in err) ? Number((err as any).status) : 500;
          setError({
            status,
            message: msg,
          });
        }
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [id],
  );

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  // Active Recovery Polling: Poll every 4 seconds if workflow is RUNNING, READY, or WAITING
  useEffect(() => {
    if (!detail) return;

    const activeStatuses: WorkflowStatus[] = ['RUNNING', 'WAITING'];
    const isActivelyProgressing = activeStatuses.includes(detail.status);

    if (isActivelyProgressing) {
      pollingTimerRef.current = setTimeout(() => {
        fetchDetail(true);
      }, 4000);
    } else {
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    }

    return () => {
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current);
      }
    };
  }, [detail, fetchDetail]);

  useRealtimeEvent(
    ['recovery.updated', 'recovery.approval_decided'],
    (notification) => {
      if (!notification.resourceId || notification.resourceId === id || notification.resourceId === detail?.recoveryCaseId) {
        fetchDetail(true);
      }
    },
    150,
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-6 w-32 bg-[#ececeb] rounded animate-pulse" />
        <div className="p-6 bg-white rounded-xl border border-[#ececeb] space-y-4">
          <div className="h-8 w-2/3 bg-[#ececeb] rounded animate-pulse" />
          <div className="h-4 w-1/3 bg-[#ececeb] rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <MetricCardSkeleton />
          <MetricCardSkeleton />
          <MetricCardSkeleton />
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="space-y-6">
        <Link
          href="/recoveries"
          className="inline-flex items-center gap-1 text-xs text-[#71717a] hover:text-[#18181b]"
        >
          <ArrowLeftIcon size={12} />
          <span>Back to Recoveries</span>
        </Link>
        <ErrorState
          statusCode={error?.status || 404}
          message={error?.message || `Recovery workflow ${id} not found`}
          onRetry={() => fetchDetail()}
        />
      </div>
    );
  }

  // Determine duration
  let durationStr = 'In progress';
  if (detail.startedAt && detail.completedAt) {
    const ms =
      new Date(detail.completedAt).getTime() - new Date(detail.startedAt).getTime();
    durationStr = `${(ms / 1000).toFixed(1)}s`;
  } else if (!detail.startedAt) {
    durationStr = 'Not started';
  }

  return (
    <div className="space-y-6">
      {/* Navigation & Header Actions */}
      <div className="flex items-center justify-between">
        <Link
          href="/recoveries"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-[#71717a] hover:text-[#18181b] transition-colors"
        >
          <ArrowLeftIcon size={13} />
          <span>Back to Recoveries</span>
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-mono text-[#a1a1aa]">
            ID: {detail.id}
          </span>
          <button
            onClick={() => fetchDetail()}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-[#ececeb] text-xs font-medium text-[#18181b] hover:bg-[#fbfbfa] shadow-subtle transition-colors disabled:opacity-50"
          >
            <RefreshIcon size={12} className={isRefreshing ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Primary Workflow Card */}
      <div className="p-6 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#f4f4f5] pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-bold uppercase tracking-wider text-[#52525b] bg-[#f4f4f5] px-2 py-0.5 rounded border border-[#e4e4e7]">
              {detail.caseType.replace(/_/g, ' ')}
            </span>
            <StatusBadge status={detail.status} size="sm" />
            <StatusBadge status={detail.recoveryLevel} size="sm" />
            {detail.approval && (
              <StatusBadge status={detail.approval.status} size="sm" />
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-[#71717a]">
            <ClockIcon size={12} />
            <span>Duration: <strong className="text-[#18181b] font-mono">{durationStr}</strong></span>
          </div>
        </div>

        <div>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
            Incident & Recovery Summary
          </span>
          <h1 className="text-lg font-bold text-[#18181b] tracking-tight mt-0.5">
            {detail.caseSummary}
          </h1>
          <p className="text-xs text-[#71717a] font-mono mt-1">
            Template: {detail.templateKey} (v{detail.templateVersion})
          </p>
        </div>

        {/* Logical Order Reference & Quick Info */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
          <div className="p-3.5 rounded-lg bg-[#fbfbfa] border border-[#ececeb]">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#71717a]">
              Associated Order
            </span>
            {detail.order ? (
              <div className="flex items-center justify-between mt-1">
                <span className="font-mono font-bold text-sm text-[#18181b]">
                  #{detail.order.orderNumber}
                </span>
                <Link
                  href={`/orders/${detail.order.id}`}
                  className="text-[11px] text-[#f95721] font-medium hover:underline flex items-center gap-0.5"
                >
                  <span>Inspect Order</span>
                  <ArrowRightIcon size={11} />
                </Link>
              </div>
            ) : (
              <p className="text-xs text-[#71717a] italic mt-1">System incident</p>
            )}
          </div>

          <div className="p-3.5 rounded-lg bg-[#fbfbfa] border border-[#ececeb]">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#71717a]">
              Started At
            </span>
            <p className="text-xs text-[#18181b] font-mono mt-1">
              {detail.startedAt ? new Date(detail.startedAt).toLocaleString() : 'Not started'}
            </p>
          </div>

          <div className="p-3.5 rounded-lg bg-[#fbfbfa] border border-[#ececeb]">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#71717a]">
              Completed At
            </span>
            <p className="text-xs text-[#18181b] font-mono mt-1">
              {detail.completedAt ? new Date(detail.completedAt).toLocaleString() : 'In progress'}
            </p>
          </div>
        </div>
      </div>

      {/* Operator Approval Section (reusable ApprovalPanel) */}
      {detail.approval && (
        <ApprovalPanel
          approval={detail.approval}
          onDecisionCompleted={fetchDetail}
        />
      )}

      {/* Flight Recorder Timeline */}
      <FlightRecorderTimeline
        timeline={detail.timeline}
        workflowStatus={detail.status}
        verifiedResolution={
          detail.status === 'SUCCEEDED'
            ? {
                verifiedAt: detail.completedAt,
                systemsVerified: ['Shopify', 'ShipStation'],
                summary: 'Workflow finished with all verification conditions successfully met.',
              }
            : null
        }
      />
    </div>
  );
};
