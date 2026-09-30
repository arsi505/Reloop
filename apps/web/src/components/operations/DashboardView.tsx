'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  DashboardSummaryDto,
  ExceptionListItemDto,
  IntegrationCardDto,
  PaginatedResponse,
  RecoveryCaseStatus,
} from '@reloop/contracts';
import { apiClient } from '../../lib/api-client';
import { useRealtimeEvent } from '../../context/realtime-context';
import { StatusBadge } from '../ui/StatusBadge';
import { MetricCardSkeleton, TableRowSkeleton } from '../ui/Skeleton';
import { ErrorState } from '../ui/ErrorState';
import { EmptyState } from '../ui/EmptyState';
import {
  RefreshIcon,
  ProviderIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  ClockIcon,
  SearchIcon,
  ShieldIcon,
  ExceptionsIcon,
} from '../icons/Icons';

interface DashboardViewProps {
  userName: string;
  onInspectException?: (id: string) => void;
  onInspectWorkflow?: (id: string) => void;
}

export function DashboardView({
  userName,
  onInspectException,
  onInspectWorkflow,
}: DashboardViewProps) {
  const [summary, setSummary] = useState<DashboardSummaryDto | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryStatusCode, setSummaryStatusCode] = useState<number | undefined>(undefined);

  // Queue table state
  const [queueData, setQueueData] = useState<PaginatedResponse<ExceptionListItemDto> | null>(null);
  const [queueFilter, setQueueFilter] = useState<'ALL' | 'WAITING_APPROVAL' | 'BLOCKED' | 'INVESTIGATING'>('ALL');
  const [loadingQueue, setLoadingQueue] = useState(false);

  // Integrations state
  const [integrations, setIntegrations] = useState<IntegrationCardDto[]>([]);

  const fetchDashboardData = useCallback(async () => {
    setLoadingSummary(true);
    setSummaryError(null);
    setSummaryStatusCode(undefined);

    try {
      const [summaryRes, integrationsRes] = await Promise.all([
        apiClient.getDashboardSummary(),
        apiClient.getIntegrations().catch(() => [] as IntegrationCardDto[]),
      ]);
      setSummary(summaryRes);
      setIntegrations(integrationsRes);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load dashboard data';
      setSummaryError(msg);
      if (msg.includes('401')) setSummaryStatusCode(401);
      else if (msg.includes('403')) setSummaryStatusCode(403);
      else if (msg.includes('404')) setSummaryStatusCode(404);
      else setSummaryStatusCode(500);
    } finally {
      setLoadingSummary(false);
    }
  }, []);

  const fetchQueue = useCallback(async (filter: 'ALL' | 'WAITING_APPROVAL' | 'BLOCKED' | 'INVESTIGATING') => {
    setLoadingQueue(true);
    try {
      const res = await apiClient.getExceptions({
        page: 1,
        pageSize: 10,
        sortOrder: 'desc',
        status: filter !== 'ALL' ? (filter as RecoveryCaseStatus) : undefined,
      });
      setQueueData(res);
    } catch {
      // Queue failure captured gracefully
    } finally {
      setLoadingQueue(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  useEffect(() => {
    fetchQueue(queueFilter);
  }, [fetchQueue, queueFilter]);

  useRealtimeEvent(
    [
      'dashboard.changed',
      'exception.created',
      'exception.updated',
      'recovery.updated',
      'recovery.approval_decided',
      'integration.health_changed',
    ],
    () => {
      Promise.all([
        apiClient.getDashboardSummary(),
        apiClient.getIntegrations().catch(() => [] as IntegrationCardDto[]),
      ])
        .then(([s, i]) => {
          setSummary(s);
          setIntegrations(i);
        })
        .catch(() => {});
      fetchQueue(queueFilter);
    },
    300,
  );

  if (summaryError) {
    return (
      <div className="max-w-[1440px] mx-auto space-y-6">
        <ErrorState
          statusCode={summaryStatusCode}
          message={summaryError}
          onRetry={fetchDashboardData}
        />
      </div>
    );
  }

  const firstName = userName ? userName.split(' ')[0] : 'Operator';

  return (
    <div className="operations-dashboard mx-auto max-w-[1440px] space-y-7">
      {/* Header Row */}
      <div className="flex flex-col gap-6 border-b border-reloop-line pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <p className="brand-data text-[11px] font-semibold tracking-[0.09em] text-reloop-signal-hover sm:text-xs">LIVE OPERATING PICTURE / {firstName.toUpperCase()}</p>
          <h2 className="mt-3 font-display text-[clamp(2.3rem,4vw,4.15rem)] font-[620] leading-[0.95] tracking-[-0.05em] text-reloop-ink">
            Keep every order<br className="hidden sm:block" /> in a trusted state.
          </h2>
          <p className="mt-4 max-w-xl text-sm leading-6 text-reloop-muted">
            Exceptions, approvals, and verified recovery evidence—ordered by what needs operator attention now.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex min-h-10 items-center gap-2 border border-reloop-line bg-reloop-surface px-3 brand-data text-[11px] font-semibold tracking-[0.06em] text-reloop-muted">
            <ClockIcon size={13} className="text-reloop-verified" />
            <span>LIVE FEED</span>
          </div>
          <button
            onClick={() => {
              fetchDashboardData();
              fetchQueue(queueFilter);
            }}
            disabled={loadingSummary}
            className="brand-button min-h-10 border border-reloop-line-strong bg-transparent px-3 text-reloop-ink hover:border-reloop-ink"
          >
            <RefreshIcon
              size={12}
              className={`text-reloop-muted ${loadingSummary ? 'animate-spin' : ''}`}
            />
            <span>Refresh data</span>
          </button>
        </div>
      </div>

      {/* 4 Real Day 17 Metric Cards (Zero fake revenue/recovery rate!) */}
      <div className="dashboard-metrics grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loadingSummary ? (
          <>
            <MetricCardSkeleton />
            <MetricCardSkeleton />
            <MetricCardSkeleton />
            <MetricCardSkeleton />
          </>
        ) : (
          <>
            {/* Card 1: Open Exceptions */}
            <div className="p-4 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-2">
              <div className="flex items-center justify-between">
                <span className="brand-data text-[11px] font-semibold tracking-[0.06em] text-reloop-muted">01 / OPEN EXCEPTIONS</span>
                <ExceptionsIcon size={14} className="text-[#f95721] shrink-0" />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-[#18181b]">
                  {summary?.openExceptionsCount ?? 0}
                </span>
                <span className="text-[11px] text-[#71717a]">active queue</span>
              </div>
              <div className="text-[11px] text-[#71717a] flex items-center justify-between pt-1 border-t border-[#f4f4f5]">
                <span>Total detected</span>
                <span className="font-semibold text-[#18181b]">
                  {summary?.totalExceptionsCount ?? 0}
                </span>
              </div>
            </div>

            {/* Card 2: Needs Approval */}
            <div className="p-4 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-2">
              <div className="flex items-center justify-between">
                <span className="brand-data text-[11px] font-semibold tracking-[0.06em] text-reloop-muted">02 / NEEDS APPROVAL</span>
                <ClockIcon size={14} className="text-[#f59e0b] shrink-0" />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-[#b45309]">
                  {summary?.casesRequiringApprovalCount ?? 0}
                </span>
                <span className="text-[11px] text-[#71717a]">awaiting operator</span>
              </div>
              <div className="text-[11px] text-[#71717a] flex items-center justify-between pt-1 border-t border-[#f4f4f5]">
                <span>Policy barrier</span>
                <span className="font-semibold text-[#b45309]">Human gate</span>
              </div>
            </div>

            {/* Card 3: Blocked Cases */}
            <div className="p-4 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-2">
              <div className="flex items-center justify-between">
                <span className="brand-data text-[11px] font-semibold tracking-[0.06em] text-reloop-muted">03 / BLOCKED CASES</span>
                <ShieldIcon size={14} className="text-[#ef4444] shrink-0" />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-[#b91c1c]">
                  {summary?.blockedCasesCount ?? 0}
                </span>
                <span className="text-[11px] text-[#71717a]">halted safely</span>
              </div>
              <div className="text-[11px] text-[#71717a] flex items-center justify-between pt-1 border-t border-[#f4f4f5]">
                <span>Automated halt</span>
                <span className="font-semibold text-[#b91c1c]">Protected</span>
              </div>
            </div>

            {/* Card 4: Resolved Cases */}
            <div className="p-4 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-2">
              <div className="flex items-center justify-between">
                <span className="brand-data text-[11px] font-semibold tracking-[0.06em] text-reloop-muted">04 / RESOLVED CASES</span>
                <CheckCircleIcon size={14} className="text-[#10b981] shrink-0" />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-[#047857]">
                  {summary?.resolvedCasesCount ?? 0}
                </span>
                <span className="text-[11px] text-[#71717a]">integrity intact</span>
              </div>
              <div className="text-[11px] text-[#71717a] flex items-center justify-between pt-1 border-t border-[#f4f4f5]">
                <span>Auto-investigated</span>
                <span className="font-semibold text-[#18181b]">
                  {summary?.autoInvestigateCasesCount ?? 0}
                </span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Central Grid: Main Left Column (68%) + Right Rail (32%) */}
      <div className="dashboard-layout grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Main Left Column (8 cols = 67%) */}
        <div className="lg:col-span-8 space-y-6">
          {/* Active Exception Queue Table */}
          <div className="rounded-xl bg-white border border-[#ececeb] shadow-subtle overflow-hidden">
            {/* Table Header & Filters */}
            <div className="p-4 border-b border-[#ececeb] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <h3 className="text-sm font-semibold text-[#18181b]">
                  Active Exception Queue
                </h3>
                <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-[#f4f4f5] text-[#52525b] border border-[#e4e4e7]">
                  {queueData?.total ?? 0} total
                </span>
              </div>

              {/* Filter Tabs */}
              <div className="flex items-center gap-1 bg-[#f4f4f5] p-0.5 rounded-lg text-[11px] font-medium text-[#71717a]">
                {(['ALL', 'WAITING_APPROVAL', 'BLOCKED', 'INVESTIGATING'] as const).map(
                  (tab) => {
                    const isSelected = queueFilter === tab;
                    const label =
                      tab === 'ALL'
                        ? 'All'
                        : tab === 'WAITING_APPROVAL'
                        ? 'Approval'
                        : tab === 'BLOCKED'
                        ? 'Blocked'
                        : 'Investigating';
                    return (
                      <button
                        key={tab}
                        onClick={() => setQueueFilter(tab)}
                        className={`px-2.5 py-1 rounded-md transition-all ${
                          isSelected
                            ? 'bg-white text-[#18181b] shadow-subtle font-semibold'
                            : 'hover:text-[#18181b]'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  },
                )}
              </div>
            </div>

            {/* Table Body */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[#ececeb] text-[#71717a] bg-[#fbfbfa]">
                    <th className="py-2.5 px-4 font-medium">Issue / Discrepancy</th>
                    <th className="py-2.5 px-4 font-medium">Order #</th>
                    <th className="py-2.5 px-4 font-medium">System</th>
                    <th className="py-2.5 px-4 font-medium">Recovery Level</th>
                    <th className="py-2.5 px-4 font-medium">Status</th>
                    <th className="py-2.5 px-4 font-medium">Detected</th>
                    <th className="py-2.5 px-4 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#ececeb]">
                  {loadingQueue ? (
                    <>
                      <TableRowSkeleton />
                      <TableRowSkeleton />
                      <TableRowSkeleton />
                      <TableRowSkeleton />
                    </>
                  ) : !queueData || queueData.items.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10">
                        <EmptyState
                          title="Queue is clear"
                          description="No active exceptions found matching current filter."
                        />
                      </td>
                    </tr>
                  ) : (
                    queueData.items.map((item) => (
                      <tr
                        key={item.id}
                        className="hover:bg-[#fbfbfa] transition-colors group"
                      >
                        <td className="py-3 px-4">
                          <Link
                            href={`/exceptions/${item.id}`}
                            className="font-medium text-[#18181b] hover:text-[#f95721] line-clamp-1 block"
                          >
                            {item.summary}
                          </Link>
                          <span className="text-[10px] text-[#71717a] font-mono">
                            {item.type}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-mono font-medium text-[#18181b]">
                          {item.order ? (
                            <Link
                              href={`/orders/${item.order.id}`}
                              className="hover:text-[#f95721] hover:underline"
                            >
                              #{item.order.orderNumber}
                            </Link>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-3 px-4">
                          {item.provider ? (
                            <ProviderIcon provider={item.provider} />
                          ) : (
                            <span className="text-[#a1a1aa]">—</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <StatusBadge status={item.recoveryLevel} size="sm" showDot={false} />
                        </td>
                        <td className="py-3 px-4">
                          <StatusBadge status={item.status} size="sm" />
                        </td>
                        <td className="py-3 px-4 text-[#71717a] text-[11px] whitespace-nowrap">
                          {new Date(item.detectedAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </td>
                        <td className="py-3 px-4 text-right">
                          {onInspectException ? (
                            <button
                              onClick={() => onInspectException(item.id)}
                              className="px-2 py-1 rounded bg-[#f4f4f5] hover:bg-white hover:border hover:border-[#ececeb] text-[11px] font-medium text-[#18181b] transition-all"
                            >
                              Inspect
                            </button>
                          ) : (
                            <Link
                              href={`/exceptions/${item.id}`}
                              className="px-2 py-1 rounded bg-[#f4f4f5] hover:bg-white hover:border hover:border-[#ececeb] text-[11px] font-medium text-[#18181b] transition-all inline-block"
                            >
                              Inspect
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Table Footer */}
            <div className="p-3 border-t border-[#ececeb] bg-[#fbfbfa] flex items-center justify-between text-xs text-[#71717a]">
              <span>
                Showing {queueData?.items.length ?? 0} of {queueData?.total ?? 0} exceptions
              </span>
              <Link
                href="/exceptions"
                className="text-[#f95721] font-medium hover:underline text-[11px]"
              >
                View all exceptions →
              </Link>
            </div>
          </div>

          {/* Split Bottom Area: Recent Recoveries & Connected Integrations */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {/* Card A: Recent Recovery Operations */}
            <div className="p-4 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
                  Recent Recovery Activity
                </h3>
                <span className="text-[10px] text-[#71717a]">Day 17 flight log</span>
              </div>

              <div className="space-y-2">
                {summary?.recentRecoveryActivity &&
                summary.recentRecoveryActivity.length > 0 ? (
                  summary.recentRecoveryActivity.slice(0, 4).map((rec) => (
                    <div
                      key={rec.workflowId}
                      onClick={() => onInspectWorkflow && onInspectWorkflow(rec.workflowId)}
                      className={`p-2.5 rounded-lg bg-[#fbfbfa] border border-[#ececeb] flex items-center justify-between ${
                        onInspectWorkflow ? 'hover:border-[#d4d4d8] cursor-pointer' : ''
                      }`}
                    >
                      <div>
                        <p className="font-semibold text-xs text-[#18181b]">
                          {rec.templateKey}
                        </p>
                        <p className="text-[10px] text-[#71717a]">
                          {rec.caseType.replace(/_/g, ' ')}
                        </p>
                      </div>
                      <StatusBadge status={rec.status} size="sm" />
                    </div>
                  ))
                ) : (
                  <EmptyState
                    title="No recovery activity"
                    description="No automated or manual recovery runs recorded yet."
                    className="py-6"
                  />
                )}
              </div>
            </div>

            {/* Card B: Connected Integrations */}
            <div className="p-4 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
                  Connected Systems
                </h3>
                <span className="text-[10px] text-[#71717a]">Safety Lock Active</span>
              </div>

              <div className="space-y-2">
                {integrations.length > 0 ? (
                  integrations.map((integ) => (
                    <div
                      key={integ.id}
                      className="p-2.5 rounded-lg bg-[#fbfbfa] border border-[#ececeb] flex items-center justify-between gap-2"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <ProviderIcon provider={integ.provider} />
                        <div className="min-w-0">
                          <p className="font-medium text-xs text-[#18181b] truncate">
                            {integ.name}
                          </p>
                          <p className="text-[10px] text-[#71717a] font-mono truncate">
                            {integ.provider === 'SHIPSTATION'
                              ? (integ.status === 'CONNECTED' ? 'Credential configured' : 'Not configured')
                              : integ.safeIdentifier}
                          </p>
                        </div>
                      </div>
                      <StatusBadge status={integ.health} size="sm" />
                    </div>
                  ))
                ) : (
                  <EmptyState
                    title="No connected systems"
                    description="Connect Shopify or ShipStation to begin monitoring."
                    className="py-6"
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Rail (4 cols = 33%) */}
        <div className="lg:col-span-4 space-y-6">
          {/* Recovery Status Rollup Card */}
          <div className="p-5 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-4">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
                Recovery Status Breakdown
              </h3>
              <p className="text-xs text-[#18181b] mt-0.5 font-medium">
                Lifecycle state of detected operational incidents
              </p>
            </div>

            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between py-1 border-b border-[#f4f4f5]">
                <span className="flex items-center gap-2 text-[#52525b]">
                  <SearchIcon size={13} className="text-[#3b82f6] shrink-0" />
                  Auto-Investigating
                </span>
                <span className="font-semibold text-[#18181b]">
                  {summary?.autoInvestigateCasesCount ?? 0}
                </span>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-[#f4f4f5]">
                <span className="flex items-center gap-2 text-[#52525b]">
                  <ClockIcon size={13} className="text-[#f59e0b] shrink-0" />
                  Awaiting Approval
                </span>
                <span className="font-semibold text-[#b45309]">
                  {summary?.casesRequiringApprovalCount ?? 0}
                </span>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-[#f4f4f5]">
                <span className="flex items-center gap-2 text-[#52525b]">
                  <RefreshIcon size={13} className="text-[#6366f1] shrink-0" />
                  Auto-Recovering
                </span>
                <span className="font-semibold text-[#18181b]">
                  {summary?.autoRecoveryCasesCount ?? 0}
                </span>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-[#f4f4f5]">
                <span className="flex items-center gap-2 text-[#52525b]">
                  <ShieldIcon size={13} className="text-[#ef4444] shrink-0" />
                  Blocked Cases
                </span>
                <span className="font-semibold text-[#b91c1c]">
                  {summary?.blockedCasesCount ?? 0}
                </span>
              </div>

              <div className="flex items-center justify-between py-1">
                <span className="flex items-center gap-2 text-[#52525b]">
                  <CheckCircleIcon size={13} className="text-[#10b981] shrink-0" />
                  Resolved
                </span>
                <span className="font-semibold text-[#047857]">
                  {summary?.resolvedCasesCount ?? 0}
                </span>
              </div>
            </div>
          </div>

          {/* System Health & Sync Status Card */}
          <div className="p-5 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-4">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
                System Health & Sync
              </h3>
              <p className="text-xs text-[#18181b] mt-0.5 font-medium">
                External adapter connectivity & rate state
              </p>
            </div>

            {/* Health Banner */}
            {summary?.integrationHealthSummary.degraded &&
            summary.integrationHealthSummary.degraded > 0 ? (
              <div className="p-3 rounded-lg bg-[#fffbeb] border border-[#fde68a] text-[#b45309] text-xs flex items-center gap-2">
                <AlertCircleIcon size={16} className="text-[#d97706] shrink-0" />
                <span>
                  {summary.integrationHealthSummary.degraded} integration(s) degraded
                </span>
              </div>
            ) : (
              <div className="p-3 rounded-lg bg-[#ecfdf5] border border-[#a7f3d0] text-[#047857] text-xs flex items-center gap-2">
                <CheckCircleIcon size={16} className="text-[#10b981] shrink-0" />
                <span className="font-medium">All connected systems operational</span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 pt-2 text-xs">
              <div className="p-2.5 rounded-lg bg-[#fbfbfa] border border-[#ececeb]">
                <span className="text-[#71717a] block text-[11px]">Healthy</span>
                <span className="font-bold text-base text-[#047857]">
                  {summary?.integrationHealthSummary.healthy ?? 0}
                </span>
              </div>
              <div className="p-2.5 rounded-lg bg-[#fbfbfa] border border-[#ececeb]">
                <span className="text-[#71717a] block text-[11px]">Syncing</span>
                <span className="font-bold text-base text-[#1d4ed8]">
                  {summary?.integrationHealthSummary.syncing ?? 0}
                </span>
              </div>
              <div className="p-2.5 rounded-lg bg-[#fbfbfa] border border-[#ececeb]">
                <span className="text-[#71717a] block text-[11px]">Degraded</span>
                <span className="font-bold text-base text-[#b45309]">
                  {summary?.integrationHealthSummary.degraded ?? 0}
                </span>
              </div>
              <div className="p-2.5 rounded-lg bg-[#fbfbfa] border border-[#ececeb]">
                <span className="text-[#71717a] block text-[11px]">Disconnected</span>
                <span className="font-bold text-base text-[#71717a]">
                  {summary?.integrationHealthSummary.disconnected ?? 0}
                </span>
              </div>
            </div>

            <div className="pt-2 border-t border-[#f4f4f5] text-[11px] text-[#71717a] flex items-center justify-between">
              <span>Mode:</span>
              <span className="px-1.5 py-0.5 rounded bg-[#f4f4f5] border border-[#e4e4e7] font-mono text-[#18181b]">
                READ_ONLY (Safe)
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
