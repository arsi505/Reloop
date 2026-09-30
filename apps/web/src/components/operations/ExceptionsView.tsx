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
import { ExceptionSystemBadge } from '../ui/ExceptionSystemBadge';
import { TableRowSkeleton } from '../ui/Skeleton';
import { ErrorState } from '../ui/ErrorState';
import { EmptyState } from '../ui/EmptyState';
import { RefreshControl } from './OperationalPageHeader';
import {
  SearchIcon,
  ChevronDownIcon,
  ArrowRightIcon,
  XIcon,
  ExceptionsIcon,
  RefreshIcon,
  ShieldIcon,
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

  const visibleItems = data?.items ?? [];
  const recoveringCount = visibleItems.filter((item) =>
    ['RECOVERING', 'AUTO_RECOVERING', 'INVESTIGATING'].includes(item.status),
  ).length;
  const blockedCount = visibleItems.filter((item) => item.status === 'BLOCKED').length;

  const activeFilterChips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (debouncedSearch) activeFilterChips.push({ key: 'search', label: `Search: ${debouncedSearch}`, clear: () => { setSearchInput(''); setDebouncedSearch(''); setPage(1); } });
  if (status) activeFilterChips.push({ key: 'status', label: formatFilterLabel(status), clear: () => { setStatus(''); setPage(1); } });
  if (recoveryLevel) activeFilterChips.push({ key: 'recovery', label: formatFilterLabel(recoveryLevel), clear: () => { setRecoveryLevel(''); setPage(1); } });
  if (caseType) activeFilterChips.push({ key: 'type', label: formatFilterLabel(caseType), clear: () => { setCaseType(''); setPage(1); } });
  if (provider) activeFilterChips.push({ key: 'provider', label: formatFilterLabel(provider), clear: () => { setProvider(''); setPage(1); } });

  const filterControlClass = 'h-10 w-full appearance-none rounded-lg border border-reloop-line bg-reloop-paper pl-3 pr-8 text-xs font-medium text-reloop-ink outline-none transition-all hover:border-reloop-line-strong focus:border-reloop-signal/50 focus:bg-reloop-surface focus:ring-2 focus:ring-reloop-signal/10';

  return (
    <div className="operations-view mx-auto max-w-[1440px] space-y-5">
      {/* Compact operational context */}
      <header className="flex flex-col gap-4 border-b border-reloop-line pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="brand-data text-[10px] font-semibold tracking-[0.1em] text-reloop-signal-hover">OPERATIONAL TRIAGE</p>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-reloop-muted">
            {loading ? 'Loading exception activity…' : `${data?.total ?? 0} exceptions in the current queue, ordered by what needs operator attention.`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {hasActiveFilters && (
            <button
              onClick={handleResetFilters}
              className="h-10 rounded-lg px-3 text-xs font-semibold text-reloop-signal-hover transition-colors hover:bg-reloop-signal-soft"
            >
              Reset filters
            </button>
          )}
          <RefreshControl loading={loading} onClick={fetchExceptions} />
        </div>
      </header>

      {/* Queue summary */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Exception queue summary">
        <div className="rounded-xl border border-reloop-line bg-reloop-surface p-4 shadow-subtle">
          <div className="flex items-center justify-between"><span className="text-xs font-medium text-reloop-muted">Queue total</span><ExceptionsIcon size={14} className="text-reloop-signal shrink-0" /></div>
          <p className="mt-2 font-display text-3xl font-[620] tracking-[-0.04em] text-reloop-ink">{loading ? '—' : data?.total ?? 0}</p>
        </div>
        <div className="rounded-xl border border-reloop-line bg-reloop-surface p-4 shadow-subtle">
          <div className="flex items-center justify-between"><span className="text-xs font-medium text-reloop-muted">Recovering</span><RefreshIcon size={14} className="text-[#315e73] shrink-0" /></div>
          <p className="mt-2 font-display text-3xl font-[620] tracking-[-0.04em] text-[#315e73]">{loading ? '—' : recoveringCount}</p>
        </div>
        <div className="rounded-xl border border-reloop-line bg-reloop-surface p-4 shadow-subtle">
          <div className="flex items-center justify-between"><span className="text-xs font-medium text-reloop-muted">Blocked</span><ShieldIcon size={14} className="text-reloop-critical shrink-0" /></div>
          <p className="mt-2 font-display text-3xl font-[620] tracking-[-0.04em] text-reloop-critical">{loading ? '—' : blockedCount}</p>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="operations-toolbar rounded-xl border border-reloop-line bg-reloop-surface p-3 shadow-subtle">
        <div className="grid gap-2.5 lg:grid-cols-2 xl:grid-cols-[minmax(240px,1.5fr)_repeat(4,minmax(135px,1fr))]">
        {/* Search Input (Debounced) */}
        <div className="relative min-w-0">
          <SearchIcon
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a1a1aa]"
          />
          <input
            type="text"
            placeholder="Search by summary, order #, dedupe key..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-10 w-full rounded-lg border border-reloop-line bg-reloop-paper pl-9 pr-3 text-xs text-reloop-ink outline-none transition-all placeholder:text-reloop-faint hover:border-reloop-line-strong focus:border-reloop-signal/50 focus:bg-reloop-surface focus:ring-2 focus:ring-reloop-signal/10"
          />
        </div>

        {/* Status Filter */}
        <div className="relative min-w-0">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by Status"
            className={filterControlClass}
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
        <div className="relative min-w-0">
          <select
            value={recoveryLevel}
            onChange={(e) => {
              setRecoveryLevel(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by Recovery Level"
            className={filterControlClass}
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
        <div className="relative min-w-0">
          <select
            value={caseType}
            onChange={(e) => {
              setCaseType(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by Incident Type"
            className={filterControlClass}
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
        <div className="relative min-w-0">
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by Provider"
            className={filterControlClass}
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

        <div className="mt-3 flex min-h-6 flex-wrap items-center gap-2 border-t border-reloop-line/70 pt-3">
          <span className="mr-1 text-[11px] font-medium text-reloop-muted">{loading ? 'Updating…' : `${data?.total ?? 0} results`}</span>
          {activeFilterChips.length === 0 ? (
            <span className="text-[11px] text-reloop-faint">No filters applied</span>
          ) : activeFilterChips.map((chip) => (
            <button key={chip.key} type="button" onClick={chip.clear} className="inline-flex h-6 items-center gap-1.5 rounded-md border border-reloop-line bg-reloop-paper px-2 text-[10px] font-semibold text-reloop-muted transition-colors hover:border-reloop-line-strong hover:text-reloop-ink">
              {chip.label}<XIcon size={10} />
            </button>
          ))}
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
        <div className="operations-table overflow-hidden rounded-xl border border-reloop-line bg-reloop-surface shadow-card">
          {/* Compact card rows keep the queue readable in narrow workspaces. */}
          <div className="divide-y divide-reloop-line xl:hidden">
            {loading ? (
              Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className="animate-pulse p-4">
                  <div className="h-3 w-3/4 rounded bg-reloop-line" />
                  <div className="mt-3 h-6 w-1/2 rounded bg-reloop-paper" />
                </div>
              ))
            ) : !data || data.items.length === 0 ? (
              <div className="py-10">
                <EmptyState
                  title={hasActiveFilters ? 'No matching exceptions' : 'No active exceptions'}
                  description={hasActiveFilters ? 'No exceptions match the selected filters.' : 'All systems operational. No exceptions detected in this organization.'}
                />
              </div>
            ) : data.items.map((item) => (
              <article
                key={item.id}
                role="link"
                tabIndex={0}
                onClick={() => onInspectException ? onInspectException(item.id) : router.push(`/exceptions/${item.id}`)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onInspectException ? onInspectException(item.id) : router.push(`/exceptions/${item.id}`);
                }}
                className="group cursor-pointer p-4 transition-colors hover:bg-reloop-paper focus-visible:bg-reloop-paper focus-visible:outline-none"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-5 text-reloop-ink transition-colors group-hover:text-reloop-signal-hover">{item.summary}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {item.order && <span className="brand-data text-[10px] font-semibold text-reloop-muted">#{item.order.orderNumber}</span>}
                      <ExceptionSystemBadge type={item.type} provider={item.provider} />
                    </div>
                  </div>
                  <ArrowRightIcon size={16} className="mt-1 shrink-0 text-reloop-faint transition-transform group-hover:translate-x-0.5 group-hover:text-reloop-signal" />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <StatusBadge status={item.recoveryLevel} size="sm" showDot={false} />
                  <StatusBadge status={item.status} size="sm" />
                  <span className="ml-auto whitespace-nowrap text-[10px] text-reloop-faint">
                    {new Date(item.detectedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </article>
            ))}
          </div>

          <div className="hidden overflow-x-auto xl:block">
            <table className="w-full table-fixed text-left text-xs">
              <colgroup>
                <col className="w-[32%]" /><col className="w-[9%]" /><col className="w-[13%]" /><col className="w-[15%]" /><col className="w-[12%]" /><col className="w-[13%]" /><col className="w-[6%]" />
              </colgroup>
              <thead className="sticky top-0 z-[5]">
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
                      tabIndex={0}
                      onClick={() => onInspectException ? onInspectException(item.id) : router.push(`/exceptions/${item.id}`)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') onInspectException ? onInspectException(item.id) : router.push(`/exceptions/${item.id}`);
                      }}
                      className="group cursor-pointer transition-colors hover:bg-reloop-paper focus-visible:bg-reloop-paper focus-visible:outline-none"
                    >
                      <td className="py-3 px-4">
                        <Link
                          href={`/exceptions/${item.id}`}
                          onClick={(event) => event.stopPropagation()}
                          className="block line-clamp-1 font-semibold text-reloop-ink hover:text-reloop-signal-hover"
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
                            onClick={(event) => event.stopPropagation()}
                            className="hover:text-reloop-signal-hover hover:underline"
                          >
                            #{item.order.orderNumber}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <ExceptionSystemBadge type={item.type} provider={item.provider} />
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
                            onClick={(event) => { event.stopPropagation(); onInspectException(item.id); }}
                            aria-label="Inspect exception"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-reloop-faint transition-all hover:bg-reloop-paper hover:text-reloop-signal"
                          >
                            <ArrowRightIcon size={14} />
                          </button>
                        ) : (
                          <Link
                            href={`/exceptions/${item.id}`}
                            onClick={(event) => event.stopPropagation()}
                            aria-label="Inspect exception"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-reloop-faint transition-all hover:bg-reloop-paper hover:text-reloop-signal"
                          >
                            <ArrowRightIcon size={14} />
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

function formatFilterLabel(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
