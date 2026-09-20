'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { IntegrationCardDto } from '@reloop/contracts';
import { apiClient } from '../../lib/api-client';
import { useRealtimeEvent } from '../../context/realtime-context';
import { StatusBadge } from '../ui/StatusBadge';
import { MetricCardSkeleton } from '../ui/Skeleton';
import { ErrorState } from '../ui/ErrorState';
import {
  ProviderIcon,
  RefreshIcon,
  ArrowRightIcon,
} from '../icons/Icons';

export const HealthView: React.FC = () => {
  const [integrations, setIntegrations] = useState<IntegrationCardDto[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<{ status?: number; message?: string } | null>(null);

  const fetchHealthData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const integrationsRes = await apiClient.getIntegrations();
      setIntegrations(integrationsRes);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch operational health data';
      const status = (err && typeof err === 'object' && 'status' in err) ? Number((err as any).status) : 500;
      setError({
        status,
        message: msg,
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealthData();
  }, [fetchHealthData]);

  useRealtimeEvent(
    ['integration.health_changed', 'integration.sync_completed', 'integration.sync_failed', 'dashboard.changed'],
    () => {
      fetchHealthData();
    },
    300,
  );

  const healthyCount = integrations.filter((i) => i.health === 'HEALTHY').length;
  const degradedCount = integrations.filter((i) => i.health === 'DEGRADED').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[#18181b]">
            System Operational Health
          </h1>
          <p className="text-xs text-[#71717a] mt-0.5">
            Factual adapter connectivity, synchronization recency, and safety barrier integrity.
          </p>
        </div>

        <button
          onClick={fetchHealthData}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-[#ececeb] text-xs font-medium text-[#18181b] hover:bg-[#fbfbfa] shadow-subtle transition-colors disabled:opacity-50"
        >
          <RefreshIcon size={12} className={isLoading ? 'animate-spin' : ''} />
          <span>Refresh Status</span>
        </button>
      </div>

      {error ? (
        <ErrorState
          statusCode={error.status}
          message={error.message}
          onRetry={fetchHealthData}
        />
      ) : (
        <>
          {/* Health Metrics Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {isLoading ? (
              Array.from({ length: 4 }).map((_, idx) => (
                <MetricCardSkeleton key={idx} />
              ))
            ) : (
              <>
                <div className="p-4 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[#71717a]">Total Integrations</span>
                    <span className="w-2 h-2 rounded-full bg-[#18181b]" />
                  </div>
                  <p className="text-2xl font-bold text-[#18181b] tracking-tight">
                    {integrations.length}
                  </p>
                  <p className="text-[11px] text-[#71717a]">Connected external providers</p>
                </div>

                <div className="p-4 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[#71717a]">Healthy Adapters</span>
                    <span className="w-2 h-2 rounded-full bg-[#10b981]" />
                  </div>
                  <p className="text-2xl font-bold text-[#10b981] tracking-tight">
                    {healthyCount}
                  </p>
                  <p className="text-[11px] text-[#71717a]">Active synchronization</p>
                </div>

                <div className="p-4 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[#71717a]">Degraded Adapters</span>
                    <span className="w-2 h-2 rounded-full bg-[#f59e0b]" />
                  </div>
                  <p className="text-2xl font-bold text-[#f59e0b] tracking-tight">
                    {degradedCount}
                  </p>
                  <p className="text-[11px] text-[#71717a]">Rate limited or transient errors</p>
                </div>

                <div className="p-4 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[#71717a]">Safety Protection</span>
                    <span className="w-2 h-2 rounded-full bg-[#f95721]" />
                  </div>
                  <p className="text-2xl font-bold text-[#18181b] tracking-tight">
                    Active
                  </p>
                  <p className="text-[11px] text-[#71717a]">Read-only mutation guardrails</p>
                </div>
              </>
            )}
          </div>

          {/* Provider Adapters Status Table */}
          <div className="rounded-xl bg-white border border-[#ececeb] shadow-subtle p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[#f4f4f5] pb-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
                Provider Adapter Health & Rate State
              </h3>
              <span className="text-[11px] text-[#a1a1aa] font-mono">Real-time health queries</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[#ececeb] text-[#71717a] font-medium">
                    <th className="py-2.5 px-3">Provider</th>
                    <th className="py-2.5 px-3">Account Domain</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3">Health Status</th>
                    <th className="py-2.5 px-3">Last Sync</th>
                    <th className="py-2.5 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#f4f4f5]">
                  {integrations.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-[#71717a] italic">
                        No provider adapters currently configured.
                      </td>
                    </tr>
                  ) : (
                    integrations.map((item) => (
                      <tr key={item.id} className="hover:bg-[#fbfbfa]">
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-2">
                            <ProviderIcon provider={item.provider} />
                            <span className="font-semibold text-[#18181b]">{item.name}</span>
                          </div>
                        </td>
                        <td className="py-3 px-3 font-mono text-[#52525b]">
                          {item.provider === 'SHIPSTATION'
                            ? (item.status === 'CONNECTED' ? 'Credential configured' : 'Not configured')
                            : item.safeIdentifier}
                        </td>
                        <td className="py-3 px-3">
                          <StatusBadge status={item.status} size="sm" />
                        </td>
                        <td className="py-3 px-3">
                          <StatusBadge status={item.health} size="sm" />
                        </td>
                        <td className="py-3 px-3 font-mono text-[#71717a]">
                          {item.lastSuccessfulSync
                            ? new Date(item.lastSuccessfulSync).toLocaleString()
                            : 'Never'}
                        </td>
                        <td className="py-3 px-3 text-right">
                          <Link
                            href={`/integrations/${item.id}`}
                            className="inline-flex items-center gap-1 text-xs text-[#f95721] hover:underline font-medium"
                          >
                            <span>Inspect Adapter</span>
                            <ArrowRightIcon size={11} />
                          </Link>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
