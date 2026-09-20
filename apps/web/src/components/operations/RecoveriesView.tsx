'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  RecoveryListItemDto,
  PaginatedResponse,
  WorkflowStatus,
  RecoveryLevel,
} from '@reloop/contracts';
import { apiClient } from '../../lib/api-client';
import { StatusBadge } from '../ui/StatusBadge';
import { TableRowSkeleton } from '../ui/Skeleton';
import { ErrorState } from '../ui/ErrorState';
import { EmptyState } from '../ui/EmptyState';
import {
  SearchIcon,
  FilterIcon,
  RefreshIcon,
  ArrowRightIcon,
  RecoveriesIcon,
} from '../icons/Icons';

export const RecoveriesView: React.FC = () => {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL query params
  const initialPage = Number(searchParams.get('page')) || 1;
  const initialSearch = searchParams.get('search') || '';
  const initialStatus = (searchParams.get('status') as WorkflowStatus) || '';
  const initialRecoveryLevel = (searchParams.get('recoveryLevel') as RecoveryLevel) || '';

  const [data, setData] = useState<PaginatedResponse<RecoveryListItemDto> | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<{ status?: number; message?: string } | null>(null);

  // Filter states
  const [search, setSearch] = useState<string>(initialSearch);
  const [status, setStatus] = useState<WorkflowStatus | ''>(initialStatus);
  const [recoveryLevel, setRecoveryLevel] = useState<RecoveryLevel | ''>(initialRecoveryLevel);
  const [page, setPage] = useState<number>(initialPage);
  const pageSize = 10;

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      syncUrlParams(1, search, status, recoveryLevel);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const syncUrlParams = (
    p: number,
    s: string,
    st: WorkflowStatus | '',
    rl: RecoveryLevel | '',
  ) => {
    const params = new URLSearchParams();
    if (p > 1) params.set('page', String(p));
    if (s) params.set('search', s);
    if (st) params.set('status', st);
    if (rl) params.set('recoveryLevel', rl);

    const query = params.toString();
    router.push(query ? `/recoveries?${query}` : '/recoveries', { scroll: false });
  };

  const fetchRecoveries = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient.getRecoveries({
        page,
        pageSize,
        search: search || undefined,
        status: status || undefined,
        recoveryLevel: recoveryLevel || undefined,
        sortOrder: 'desc',
      });
      setData(res);
    } catch (err: any) {
      setError({
        status: err.status || 500,
        message: err.message || 'Failed to load recoveries queue',
      });
    } finally {
      setIsLoading(false);
    }
  }, [page, search, status, recoveryLevel]);

  useEffect(() => {
    fetchRecoveries();
  }, [fetchRecoveries]);

  const handleFilterChange = (newStatus: WorkflowStatus | '', newLevel: RecoveryLevel | '') => {
    setStatus(newStatus);
    setRecoveryLevel(newLevel);
    setPage(1);
    syncUrlParams(1, search, newStatus, newLevel);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[#18181b]">
            Automated Recoveries
          </h1>
          <p className="text-xs text-[#71717a] mt-0.5">
            Durable workflow execution logs, approval gates, and verified resolutions.
          </p>
        </div>
        <button
          onClick={() => fetchRecoveries()}
          disabled={isLoading}
          className="self-start sm:self-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-[#ececeb] text-xs font-medium text-[#18181b] hover:bg-[#fbfbfa] shadow-subtle transition-colors disabled:opacity-50"
        >
          <RefreshIcon size={12} className={isLoading ? 'animate-spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        {/* Search */}
        <div className="relative flex-1">
          <SearchIcon
            size={14}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#a1a1aa]"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by case summary, order #, template..."
            className="w-full pl-9 pr-4 py-2 rounded-lg bg-white border border-[#ececeb] text-xs text-[#18181b] placeholder-[#a1a1aa] focus:outline-none focus:border-[#f95721] shadow-subtle transition-colors"
          />
        </div>

        {/* Status Filter */}
        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={(e) => handleFilterChange(e.target.value as WorkflowStatus | '', recoveryLevel)}
            className="px-3 py-2 rounded-lg bg-white border border-[#ececeb] text-xs text-[#18181b] focus:outline-none focus:border-[#f95721] shadow-subtle"
          >
            <option value="">All Statuses</option>
            <option value="RUNNING">Running</option>
            <option value="WAITING">Waiting (Approval)</option>
            <option value="SUCCEEDED">Succeeded (Resolved)</option>
            <option value="FAILED">Failed</option>
            <option value="BLOCKED">Blocked</option>
            <option value="PENDING">Pending</option>
          </select>

          {/* Recovery Level Filter */}
          <select
            value={recoveryLevel}
            onChange={(e) => handleFilterChange(status, e.target.value as RecoveryLevel | '')}
            className="px-3 py-2 rounded-lg bg-white border border-[#ececeb] text-xs text-[#18181b] focus:outline-none focus:border-[#f95721] shadow-subtle"
          >
            <option value="">All Recovery Levels</option>
            <option value="AUTO_INVESTIGATE">Auto Investigate</option>
            <option value="REQUIRE_APPROVAL">Require Approval</option>
            <option value="SAFE_AUTO_RECOVERY">Safe Auto Recovery</option>
            <option value="BLOCKED">Blocked</option>
          </select>
        </div>
      </div>

      {/* Main Table Surface */}
      <div className="rounded-xl bg-white border border-[#ececeb] shadow-subtle overflow-hidden">
        {error ? (
          <div className="p-6">
            <ErrorState
              statusCode={error.status}
              message={error.message}
              onRetry={fetchRecoveries}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[#ececeb] bg-[#fbfbfa]/75 text-[#71717a] font-medium select-none">
                  <th className="py-3 px-4">Case / Order</th>
                  <th className="py-3 px-4">Problem / Template</th>
                  <th className="py-3 px-4">Recovery Level</th>
                  <th className="py-3 px-4">Approval</th>
                  <th className="py-3 px-4">Workflow Status</th>
                  <th className="py-3 px-4">Started</th>
                  <th className="py-3 px-4">Completed</th>
                  <th className="py-3 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f4f4f5]">
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, idx) => (
                    <TableRowSkeleton key={idx} columns={8} />
                  ))
                ) : !data || data.items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12">
                      <EmptyState
                        title="No recovery workflows found"
                        description={
                          search || status || recoveryLevel
                            ? 'No workflows match the selected criteria.'
                            : 'No automated recoveries have been dispatched.'
                        }
                        icon={<RecoveriesIcon size={20} />}
                        action={
                          search || status || recoveryLevel ? (
                            <button
                              onClick={() => {
                                setSearch('');
                                setStatus('');
                                setRecoveryLevel('');
                                setPage(1);
                              }}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#f4f4f5] hover:bg-white text-xs font-medium text-[#18181b] border border-[#ececeb] transition-colors shadow-subtle"
                            >
                              <span>Clear filters</span>
                            </button>
                          ) : undefined
                        }
                      />
                    </td>
                  </tr>
                ) : (
                  data.items.map((item) => (
                    <tr
                      key={item.id}
                      className="hover:bg-[#fbfbfa] transition-colors group cursor-pointer"
                      onClick={() => router.push(`/recoveries/${item.id}`)}
                    >
                      {/* Case / Order */}
                      <td className="py-3.5 px-4">
                        <div className="flex flex-col">
                          {item.orderNumber ? (
                            <span className="font-mono font-semibold text-[#18181b]">
                              #{item.orderNumber}
                            </span>
                          ) : (
                            <span className="font-mono text-[#71717a] text-[11px]">System Case</span>
                          )}
                          <span className="font-mono text-[10px] text-[#a1a1aa] truncate max-w-[120px]">
                            {item.id.slice(0, 8)}...
                          </span>
                        </div>
                      </td>

                      {/* Problem / Template */}
                      <td className="py-3.5 px-4 max-w-xs">
                        <p className="font-medium text-[#18181b] truncate" title={item.caseSummary}>
                          {item.caseSummary}
                        </p>
                        <p className="text-[10px] font-mono text-[#71717a] truncate mt-0.5">
                          {item.templateKey} (v{item.templateVersion})
                        </p>
                      </td>

                      {/* Recovery Level */}
                      <td className="py-3.5 px-4">
                        <StatusBadge status={item.recoveryLevel} size="sm" />
                      </td>

                      {/* Approval */}
                      <td className="py-3.5 px-4">
                        {item.approvalStatus ? (
                          <StatusBadge status={item.approvalStatus} size="sm" />
                        ) : (
                          <span className="text-[11px] text-[#a1a1aa] italic">None</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="py-3.5 px-4">
                        <StatusBadge status={item.status} size="sm" />
                      </td>

                      {/* Started */}
                      <td className="py-3.5 px-4 text-[#71717a] font-mono text-[11px]">
                        {item.startedAt
                          ? new Date(item.startedAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : 'Pending'}
                      </td>

                      {/* Completed */}
                      <td className="py-3.5 px-4 text-[#71717a] font-mono text-[11px]">
                        {item.completedAt
                          ? new Date(item.completedAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '—'}
                      </td>

                      {/* Action */}
                      <td className="py-3.5 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <Link
                          href={`/recoveries/${item.id}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-white border border-[#ececeb] text-[#71717a] hover:text-[#18181b] hover:border-[#d4d4d8] text-xs font-medium transition-colors"
                        >
                          <span>Flight Recorder</span>
                          <ArrowRightIcon size={11} />
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Footer */}
        {data && data.totalPages > 1 && (
          <div className="p-4 border-t border-[#ececeb] bg-[#fbfbfa]/50 flex items-center justify-between text-xs text-[#71717a]">
            <div>
              Showing page <strong className="text-[#18181b]">{data.page}</strong> of{' '}
              <strong className="text-[#18181b]">{data.totalPages}</strong> ({data.total} total)
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const newPage = Math.max(1, page - 1);
                  setPage(newPage);
                  syncUrlParams(newPage, search, status, recoveryLevel);
                }}
                disabled={page <= 1 || isLoading}
                className="px-3 py-1 rounded bg-white border border-[#ececeb] text-[#18181b] disabled:opacity-40 hover:bg-[#f4f4f5] transition-colors"
              >
                Previous
              </button>
              <button
                onClick={() => {
                  const newPage = Math.min(data.totalPages, page + 1);
                  setPage(newPage);
                  syncUrlParams(newPage, search, status, recoveryLevel);
                }}
                disabled={page >= data.totalPages || isLoading}
                className="px-3 py-1 rounded bg-white border border-[#ececeb] text-[#18181b] disabled:opacity-40 hover:bg-[#f4f4f5] transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
