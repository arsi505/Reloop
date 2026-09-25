'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  ExceptionListItemDto,
  PaginatedResponse,
  RecoveryCaseStatus,
  RecoveryLevel,
  RecoveryCaseType,
  IntegrationProvider,
} from '@reloop/contracts';
import { apiClient, ExceptionsQuery } from '../../lib/api-client';
import { useRealtimeEvent } from '../../context/realtime-context';
import { StatusBadge } from '../ui/StatusBadge';
import { TableRowSkeleton } from '../ui/Skeleton';
import { ErrorState } from '../ui/ErrorState';
import { EmptyState } from '../ui/EmptyState';
import { OperationalPageHeader, RefreshControl } from './OperationalPageHeader';
import {
  ProviderIcon,
  SearchIcon,
  ChevronDownIcon,
} from '../icons/Icons';

interface ExceptionsViewProps {
  onInspectException?: (id: string) => void;
}

export function ExceptionsView({ onInspectException }: ExceptionsViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Read URL query state
  const initialPage = Number(searchParams.get('page')) || 1;
  const initialPageSize = Number(searchParams.get('pageSize')) || 15;
  const initialStatus = searchParams.get('status') || '';
  const initialLevel = searchParams.get('recoveryLevel') || '';
  const initialType = searchParams.get('type') || '';
  const initialProvider = searchParams.get('provider') || '';
  const initialSearch = searchParams.get('search') || '';

  // Component state
  const [data, setData] = useState<PaginatedResponse<ExceptionListItemDto> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusCode, setStatusCode] = useState<number | undefined>(undefined);

  // Filter state
  const [status, setStatus] = useState<string>(initialStatus);
  const [recoveryLevel, setRecoveryLevel] = useState<string>(initialLevel);
  const [caseType, setCaseType] = useState<string>(initialType);
  const [provider, setProvider] = useState<string>(initialProvider);
  const [searchInput, setSearchInput] = useState<string>(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState<string>(initialSearch);
  const [page, setPage] = useState<number>(initialPage);
  const [pageSize] = useState<number>(initialPageSize);

  // Debounce search input (300ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput);
      setPage(1); // reset to page 1 on new search
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Sync state to URL query params
  const updateUrlParams = useCallback(
    (newParams: Record<string, string | number | undefined>) => {
      const current = new URLSearchParams(searchParams.toString());
      for (const [key, val] of Object.entries(newParams)) {
        if (val !== undefined && val !== '' && val !== 'ALL') {
          current.set(key, String(val));
        } else {
          current.delete(key);
        }
      }
      const queryStr = current.toString();
      router.replace(`${pathname}${queryStr ? `?${queryStr}` : ''}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // Fetch exceptions from API
  const fetchExceptions = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatusCode(undefined);

    const query: ExceptionsQuery = {
      page,
      pageSize,
      sortOrder: 'desc',
      status: status && status !== 'ALL' ? (status as RecoveryCaseStatus) : undefined,
      recoveryLevel:
        recoveryLevel && recoveryLevel !== 'ALL' ? (recoveryLevel as RecoveryLevel) : undefined,
      type: caseType && caseType !== 'ALL' ? (caseType as RecoveryCaseType) : undefined,
      provider: provider && provider !== 'ALL' ? (provider as IntegrationProvider) : undefined,
      search: debouncedSearch ? debouncedSearch.trim() : undefined,
    };

    try {
      const res = await apiClient.getExceptions(query);
      setData(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch exceptions';
      setError(msg);
      if (msg.includes('401')) setStatusCode(401);
      else if (msg.includes('403')) setStatusCode(403);
      else if (msg.includes('404')) setStatusCode(404);
      else setStatusCode(500);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, status, recoveryLevel, caseType, provider, debouncedSearch]);

  useEffect(() => {
    fetchExceptions();
    updateUrlParams({
      page: page > 1 ? page : undefined,
      status: status || undefined,
      recoveryLevel: recoveryLevel || undefined,
      type: caseType || undefined,
      provider: provider || undefined,
      search: debouncedSearch || undefined,
    });
  }, [fetchExceptions, page, status, recoveryLevel, caseType, provider, debouncedSearch, updateUrlParams]);

  useRealtimeEvent(
    ['exception.created', 'exception.updated', 'recovery.updated', 'recovery.approval_decided'],
    () => {
      fetchExceptions();
    },
    300,
  );

  const hasActiveFilters =
    status !== '' ||
    recoveryLevel !== '' ||
    caseType !== '' ||
    provider !== '' ||
    debouncedSearch !== '';

  const handleResetFilters = () => {
    setStatus('');
    setRecoveryLevel('');
    setCaseType('');
    setProvider('');
    setSearchInput('');
    setDebouncedSearch('');
    setPage(1);
  };

  return (
    <div className="operations-view mx-auto max-w-[1440px] space-y-7">
      {/* Header */}
      <OperationalPageHeader
        index="02"
        eyebrow="OPERATOR ATTENTION / LIVE QUEUE"
        title="Exception queue."
        description="Cross-system discrepancies and integrity anomalies, ordered for clear operator judgment."
        actions={<>
          {hasActiveFilters && (
            <button
              onClick={handleResetFilters}
              className="px-2 text-xs font-semibold text-reloop-signal-hover hover:underline"
            >
              Reset filters
            </button>
          )}
          <RefreshControl loading={loading} onClick={fetchExceptions} />
        </>}
      />

      {/* Filter Toolbar */}
      <div className="operations-toolbar flex flex-wrap items-center gap-3 border border-reloop-line bg-reloop-surface p-3.5 text-xs">
        {/* Search Input (Debounced) */}
        <div className="relative flex-1 min-w-[200px]">
          <SearchIcon
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a1a1aa]"
          />
          <input
            type="text"
            placeholder="Search by summary, order #, dedupe key..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-[#fbfbfa] border border-[#ececeb] rounded-lg text-[#18181b] placeholder-[#a1a1aa] focus:outline-none focus:bg-white focus:border-[#d4d4d8]"
          />
        </div>

        {/* Status Filter */}
        <div className="relative">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by Status"
            className="appearance-none pl-3 pr-8 py-1.5 bg-[#fbfbfa] border border-[#ececeb] rounded-lg text-xs font-medium text-[#18181b] focus:outline-none cursor-pointer"
          >
            <option value="">All Statuses</option>
            <option value="DETECTED">Detected</option>
            <option value="INVESTIGATING">Investigating</option>
            <option value="WAITING_APPROVAL">Waiting Approval</option>
            <option value="RECOVERING">Recovering</option>
            <option value="RECOVERED">Recovered</option>
            <option value="BLOCKED">Blocked</option>
            <option value="FAILED">Failed</option>
          </select>
          <ChevronDownIcon
            size={12}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#71717a] pointer-events-none"
          />
        </div>

        {/* Recovery Level Filter */}
        <div className="relative">
          <select
            value={recoveryLevel}
            onChange={(e) => {
              setRecoveryLevel(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by Recovery Level"
            className="appearance-none pl-3 pr-8 py-1.5 bg-[#fbfbfa] border border-[#ececeb] rounded-lg text-xs font-medium text-[#18181b] focus:outline-none cursor-pointer"
          >
            <option value="">All Recovery Levels</option>
            <option value="AUTO_INVESTIGATE">Auto Investigate</option>
            <option value="AUTO_RECOVER">Auto Recover</option>
            <option value="REQUIRE_APPROVAL">Require Approval</option>
            <option value="BLOCK">Block</option>
            <option value="IGNORE">Ignore</option>
          </select>
          <ChevronDownIcon
            size={12}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#71717a] pointer-events-none"
          />
        </div>

        {/* Case Type Filter */}
        <div className="relative">
          <select
            value={caseType}
            onChange={(e) => {
              setCaseType(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by Incident Type"
            className="appearance-none pl-3 pr-8 py-1.5 bg-[#fbfbfa] border border-[#ececeb] rounded-lg text-xs font-medium text-[#18181b] focus:outline-none cursor-pointer"
          >
            <option value="">All Incident Types</option>
            <option value="DUPLICATE_PURCHASE">Duplicate Purchase</option>
            <option value="ADDRESS_MISMATCH">Address Mismatch</option>
            <option value="INVENTORY_SHORTAGE">Inventory Shortage</option>
            <option value="FULFILLMENT_DELAY">Fulfillment Delay</option>
            <option value="TRACKING_STALLED">Tracking Stalled</option>
            <option value="CARRIER_EXCEPTION">Carrier Exception</option>
            <option value="CUSTOMS_HOLD">Customs Hold</option>
            <option value="SYSTEM_DESYNC">System Desync</option>
          </select>
          <ChevronDownIcon
            size={12}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#71717a] pointer-events-none"
          />
        </div>

        {/* Provider Filter */}
        <div className="relative">
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by Provider"
            className="appearance-none pl-3 pr-8 py-1.5 bg-[#fbfbfa] border border-[#ececeb] rounded-lg text-xs font-medium text-[#18181b] focus:outline-none cursor-pointer"
          >
            <option value="">All Providers</option>
            <option value="SHOPIFY">Shopify</option>
            <option value="SHIPSTATION">ShipStation</option>
            <option value="GENERIC_3PL">Generic 3PL</option>
          </select>
          <ChevronDownIcon
            size={12}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#71717a] pointer-events-none"
          />
        </div>
      </div>

      {/* Error View */}
      {error && (
        <ErrorState
          statusCode={statusCode}
          message={error}
          onRetry={fetchExceptions}
        />
      )}

      {/* Table Card */}
      {!error && (
        <div className="operations-table overflow-hidden border border-reloop-line bg-reloop-surface">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#ececeb] text-[#71717a] bg-[#fbfbfa]">
                  <th className="py-2.5 px-4 font-medium">Issue / Discrepancy</th>
                  <th className="py-2.5 px-4 font-medium">Order #</th>
                  <th className="py-2.5 px-4 font-medium">Provider</th>
                  <th className="py-2.5 px-4 font-medium">Recovery Level</th>
                  <th className="py-2.5 px-4 font-medium">Status</th>
                  <th className="py-2.5 px-4 font-medium">Detected</th>
                  <th className="py-2.5 px-4 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#ececeb]">
                {loading ? (
                  <>
                    <TableRowSkeleton />
                    <TableRowSkeleton />
                    <TableRowSkeleton />
                    <TableRowSkeleton />
                    <TableRowSkeleton />
                  </>
                ) : !data || data.items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12">
                      <EmptyState
                        title={hasActiveFilters ? 'No matching exceptions' : 'No active exceptions'}
                        description={
                          hasActiveFilters
                            ? 'No exceptions match the selected filters. Try changing or clearing filters.'
                            : 'All systems operational. No exceptions detected in this organization.'
                        }
                        action={
                          hasActiveFilters ? (
                            <button
                              onClick={handleResetFilters}
                              className="px-3 py-1.5 rounded-lg bg-[#f4f4f5] hover:bg-white text-xs font-medium text-[#18181b] border border-[#ececeb]"
                            >
                              Clear Filters
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
                        {new Date(item.detectedAt).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {onInspectException ? (
                          <button
                            onClick={() => onInspectException(item.id)}
                            className="px-2.5 py-1 rounded bg-[#f4f4f5] hover:bg-white hover:border hover:border-[#ececeb] text-[11px] font-medium text-[#18181b] transition-all"
                          >
                            Inspect
                          </button>
                        ) : (
                          <Link
                            href={`/exceptions/${item.id}`}
                            className="px-2.5 py-1 rounded bg-[#f4f4f5] hover:bg-white hover:border hover:border-[#ececeb] text-[11px] font-medium text-[#18181b] transition-all inline-block"
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

          {/* Server-Side Pagination Footer */}
          {data && data.totalPages > 1 && (
            <div className="p-3.5 border-t border-[#ececeb] bg-[#fbfbfa] flex items-center justify-between text-xs text-[#71717a]">
              <span>
                Page <strong className="text-[#18181b]">{data.page}</strong> of{' '}
                <strong className="text-[#18181b]">{data.totalPages}</strong> (
                {data.total} exceptions)
              </span>

              <div className="flex items-center gap-2">
                <button
                  disabled={data.page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="px-2.5 py-1 rounded bg-white border border-[#ececeb] shadow-subtle disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#f4f4f5] font-medium"
                >
                  Previous
                </button>
                <button
                  disabled={data.page >= data.totalPages}
                  onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                  className="px-2.5 py-1 rounded bg-white border border-[#ececeb] shadow-subtle disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#f4f4f5] font-medium"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
