'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  OrderListItemDto,
  PaginatedResponse,
  ExternalOrderStatus,
  IntegrationProvider,
} from '@reloop/contracts';
import { apiClient, OrdersQuery } from '../../lib/api-client';
import { StatusBadge } from '../ui/StatusBadge';
import { TableRowSkeleton } from '../ui/Skeleton';
import { ErrorState } from '../ui/ErrorState';
import { EmptyState } from '../ui/EmptyState';
import {
  ProviderIcon,
  SearchIcon,
  RefreshIcon,
  ChevronDownIcon,
  AlertCircleIcon,
  CheckCircleIcon,
} from '../icons/Icons';

interface OrdersViewProps {
  onInspectOrder?: (id: string) => void;
}

export function OrdersView({ onInspectOrder }: OrdersViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Read initial query params
  const initialPage = Number(searchParams.get('page')) || 1;
  const initialPageSize = Number(searchParams.get('pageSize')) || 15;
  const initialStatus = searchParams.get('status') || '';
  const initialProvider = searchParams.get('provider') || '';
  const initialHasException = searchParams.get('hasException') === 'true';
  const initialSearch = searchParams.get('search') || '';

  // Component state
  const [data, setData] = useState<PaginatedResponse<OrderListItemDto> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusCode, setStatusCode] = useState<number | undefined>(undefined);

  // Filters
  const [status, setStatus] = useState<string>(initialStatus);
  const [provider, setProvider] = useState<string>(initialProvider);
  const [hasException, setHasException] = useState<boolean>(initialHasException);
  const [searchInput, setSearchInput] = useState<string>(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState<string>(initialSearch);
  const [page, setPage] = useState<number>(initialPage);
  const [pageSize] = useState<number>(initialPageSize);

  // Debounce search (300ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Sync to URL
  const updateUrlParams = useCallback(
    (newParams: Record<string, string | number | boolean | undefined>) => {
      const current = new URLSearchParams(searchParams.toString());
      for (const [key, val] of Object.entries(newParams)) {
        if (val !== undefined && val !== '' && val !== false && val !== 'ALL') {
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

  // Fetch orders from API
  const fetchOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatusCode(undefined);

    const query: OrdersQuery = {
      page,
      pageSize,
      sortOrder: 'desc',
      status: status && status !== 'ALL' ? (status as ExternalOrderStatus) : undefined,
      provider: provider && provider !== 'ALL' ? (provider as IntegrationProvider) : undefined,
      hasException: hasException ? true : undefined,
      search: debouncedSearch ? debouncedSearch.trim() : undefined,
    };

    try {
      const res = await apiClient.getOrders(query);
      setData(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch orders';
      setError(msg);
      if (msg.includes('401')) setStatusCode(401);
      else if (msg.includes('403')) setStatusCode(403);
      else if (msg.includes('404')) setStatusCode(404);
      else setStatusCode(500);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, status, provider, hasException, debouncedSearch]);

  useEffect(() => {
    fetchOrders();
    updateUrlParams({
      page: page > 1 ? page : undefined,
      status: status || undefined,
      provider: provider || undefined,
      hasException: hasException ? true : undefined,
      search: debouncedSearch || undefined,
    });
  }, [fetchOrders, page, status, provider, hasException, debouncedSearch, updateUrlParams]);

  const hasActiveFilters =
    status !== '' || provider !== '' || hasException || debouncedSearch !== '';

  const handleResetFilters = () => {
    setStatus('');
    setProvider('');
    setHasException(false);
    setSearchInput('');
    setDebouncedSearch('');
    setPage(1);
  };

  return (
    <div className="space-y-6 max-w-[1440px] mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[#18181b]">
            Cross-System Orders
          </h2>
          <p className="text-xs text-[#71717a] mt-0.5">
            Unified view of logical orders comparing Shopify order intent against ShipStation physical fulfillment.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {hasActiveFilters && (
            <button
              onClick={handleResetFilters}
              className="text-xs text-[#f95721] font-medium hover:underline px-2"
            >
              Reset Filters
            </button>
          )}
          <button
            onClick={fetchOrders}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-[#fbfbfa] border border-[#ececeb] shadow-subtle text-xs font-medium text-[#18181b] transition-colors"
          >
            <RefreshIcon size={12} className={`text-[#71717a] ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="p-3.5 rounded-xl bg-white border border-[#ececeb] shadow-subtle flex flex-wrap items-center gap-3 text-xs">
        {/* Search Input (Debounced) */}
        <div className="relative flex-1 min-w-[200px]">
          <SearchIcon
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a1a1aa]"
          />
          <input
            type="text"
            placeholder="Search by order #..."
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
            <option value="OPEN">Open</option>
            <option value="CLOSED">Closed</option>
            <option value="CANCELLED">Cancelled</option>
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

        {/* Discrepancy Toggle */}
        <label className="flex items-center gap-2 text-xs text-[#52525b] cursor-pointer bg-[#fbfbfa] px-3 py-1.5 rounded-lg border border-[#ececeb] select-none hover:bg-white">
          <input
            type="checkbox"
            checked={hasException}
            onChange={(e) => {
              setHasException(e.target.checked);
              setPage(1);
            }}
            className="rounded text-[#f95721] focus:ring-0 cursor-pointer"
          />
          <span>Discrepancies Only</span>
        </label>
      </div>

      {/* Error State */}
      {error && (
        <ErrorState statusCode={statusCode} message={error} onRetry={fetchOrders} />
      )}

      {/* Table Card */}
      {!error && (
        <div className="rounded-xl bg-white border border-[#ececeb] shadow-subtle overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#ececeb] text-[#71717a] bg-[#fbfbfa]">
                  <th className="py-2.5 px-4 font-medium">Order Number</th>
                  <th className="py-2.5 px-4 font-medium">Status</th>
                  <th className="py-2.5 px-4 font-medium">Total Amount</th>
                  <th className="py-2.5 px-4 font-medium">Connected Systems</th>
                  <th className="py-2.5 px-4 font-medium">Discrepancy State</th>
                  <th className="py-2.5 px-4 font-medium">Last Observed</th>
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
                        title={hasActiveFilters ? 'No matching orders' : 'No orders recorded'}
                        description={
                          hasActiveFilters
                            ? 'No orders match the selected criteria. Try adjusting your filters.'
                            : 'Sync has not recorded any logical orders in this organization yet.'
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
                  data.items.map((order) => (
                    <tr
                      key={order.id}
                      className="hover:bg-[#fbfbfa] transition-colors group"
                    >
                      <td className="py-3 px-4 font-mono font-bold text-[#18181b]">
                        <Link
                          href={`/orders/${order.id}`}
                          className="hover:text-[#f95721] hover:underline"
                        >
                          #{order.externalOrderNumber}
                        </Link>
                      </td>
                      <td className="py-3 px-4">
                        <StatusBadge status={order.status} size="sm" />
                      </td>
                      <td className="py-3 px-4 font-medium text-[#18181b]">
                        {order.currency || 'USD'} {order.totalAmount || '0.00'}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex gap-1.5">
                          {order.connectedProviders.map((p) => (
                            <ProviderIcon key={p} provider={p} />
                          ))}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        {order.hasOpenException ? (
                          <span className="inline-flex items-center gap-1 text-[#b91c1c] font-medium text-[11px]">
                            <AlertCircleIcon size={13} />
                            {order.activeExceptionCount} Issue(s)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[#047857] font-medium text-[11px]">
                            <CheckCircleIcon size={13} />
                            In Sync
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-[#71717a] text-[11px]">
                        {new Date(order.lastObservedAt).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {onInspectOrder ? (
                          <button
                            onClick={() => onInspectOrder(order.id)}
                            className="px-2.5 py-1 rounded bg-[#f4f4f5] hover:bg-white hover:border hover:border-[#ececeb] text-[11px] font-medium text-[#18181b] transition-all"
                          >
                            Compare
                          </button>
                        ) : (
                          <Link
                            href={`/orders/${order.id}`}
                            className="px-2.5 py-1 rounded bg-[#f4f4f5] hover:bg-white hover:border hover:border-[#ececeb] text-[11px] font-medium text-[#18181b] transition-all inline-block"
                          >
                            Compare
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
                <strong className="text-[#18181b]">{data.totalPages}</strong> ({data.total} orders)
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
