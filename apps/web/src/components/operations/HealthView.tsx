'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { IntegrationCardDto } from '@reloop/contracts';
import { apiClient } from '../../lib/api-client';
import { useRealtimeEvent } from '../../context/realtime-context';
import { StatusBadge } from '../ui/StatusBadge';
import { MetricCardSkeleton } from '../ui/Skeleton';
import { ErrorState } from '../ui/ErrorState';
import { OperationalPageHeader, RefreshControl } from './OperationalPageHeader';
import {
  ProviderIcon,
  ArrowRightIcon,
  IntegrationsIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  ShieldIcon,
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
    <div className="operations-view mx-auto max-w-[1440px] space-y-7">
      {/* Header */}
      <OperationalPageHeader
        index="06"
        eyebrow="ADAPTER TELEMETRY / SAFETY STATE"
        title="System health."
        description="Factual connectivity, synchronization recency, and safety-barrier integrity across every provider adapter."
        actions={<RefreshControl loading={isLoading} onClick={fetchHealthData}>Refresh status</RefreshControl>}
      />

      {error ? (
        <ErrorState
          statusCode={error.status}
          message={error.message}
          onRetry={fetchHealthData}
        />
      ) : (
        <>
          {/* Health Metrics Grid */}
          <div className="operations-metrics grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {isLoading ? (
              Array.from({ length: 4 }).map((_, idx) => (
                <MetricCardSkeleton key={idx} />
              ))
            ) : (
              <>
                <div className="p-4 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[#71717a]">Total Integrations</span>
                    <IntegrationsIcon size={14} className="text-[#18181b] shrink-0" />
                  </div>
                  <p className="text-2xl font-bold text-[#18181b] tracking-tight">
                    {integrations.length}
                  </p>
                  <p className="text-[11px] text-[#71717a]">Connected external providers</p>
                </div>

                <div className="p-4 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[#71717a]">Healthy Adapters</span>
                    <CheckCircleIcon size={14} className="text-[#10b981] shrink-0" />
                  </div>
                  <p className="text-2xl font-bold text-[#10b981] tracking-tight">
                    {healthyCount}
                  </p>
                  <p className="text-[11px] text-[#71717a]">Active synchronization</p>
                </div>

                <div className="p-4 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[#71717a]">Degraded Adapters</span>
                    <AlertCircleIcon size={14} className="text-[#f59e0b] shrink-0" />
                  </div>
                  <p className="text-2xl font-bold text-[#f59e0b] tracking-tight">
                    {degradedCount}
                  </p>
                  <p className="text-[11px] text-[#71717a]">Rate limited or transient errors</p>
                </div>

                <div className="p-4 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[#71717a]">Safety Protection</span>
                    <ShieldIcon size={14} className="text-[#f95721] shrink-0" />
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
          <div className="operations-table space-y-4 border border-reloop-line bg-reloop-surface p-5">
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
                    <th className="py-2.5 px-3 hidden md:table-cell">Account Domain</th>
                    <th className="py-2.5 px-3 hidden md:table-cell">Status</th>
                    <th className="py-2.5 px-3">Health Status</th>
                    <th className="py-2.5 px-3 hidden sm:table-cell">Last Sync</th>
                    <th className="py-2.5 px-3 text-right hidden sm:table-cell">Action</th>
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
                        <td className="py-3 px-3 max-w-[180px] sm:max-w-none">
                          <div className="flex items-center gap-2 min-w-0">
                          <ProviderIcon provider={item.provider} size="compact" />
                          </div>
                        </td>
                        <td className="py-3 px-3 font-mono text-[#52525b] hidden md:table-cell">
                          {item.provider === 'SHIPSTATION'
                            ? (item.status === 'CONNECTED' ? 'Credential configured' : 'Not configured')
                            : item.safeIdentifier}
                        </td>
                        <td className="py-3 px-3 hidden md:table-cell">
                          <StatusBadge status={item.status} size="sm" />
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <StatusBadge status={item.health} size="sm" />
                        </td>
                        <td className="py-3 px-3 font-mono text-[#71717a] hidden sm:table-cell">
                          {item.lastSuccessfulSync
                            ? new Date(item.lastSuccessfulSync).toLocaleString()
                            : 'Never'}
                        </td>
                        <td className="py-3 px-3 text-right hidden sm:table-cell">
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
