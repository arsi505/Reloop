'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { IntegrationOperationsDetailDto } from '@reloop/contracts';
import { apiClient } from '../../lib/api-client';
import { useAuth } from '../../context/auth-context';
import { useRealtimeEvent } from '../../context/realtime-context';
import { StatusBadge } from '../ui/StatusBadge';
import { MetricCardSkeleton } from '../ui/Skeleton';
import { ErrorState } from '../ui/ErrorState';
import {
  ProviderIcon,
  ArrowLeftIcon,
  RefreshIcon,
  CheckIcon,
  AlertTriangleIcon,
  ClockIcon,
  ShieldIcon,
  XIcon,
} from '../icons/Icons';

interface IntegrationDetailViewProps {
  id: string;
}

export const IntegrationDetailView: React.FC<IntegrationDetailViewProps> = ({ id }) => {
  const router = useRouter();
  const { role } = useAuth();
  const [detail, setDetail] = useState<IntegrationOperationsDetailDto | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<{ status?: number; message?: string } | null>(null);

  // Actions state
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);
  const [showReplaceModal, setShowReplaceModal] = useState(false);
  const [replacementKey, setReplacementKey] = useState('');
  const [replacementError, setReplacementError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const isOwnerOrAdmin = role === 'OWNER' || role === 'ADMIN';

  const showToast = (type: 'success' | 'error', text: string) => {
    setToastMessage({ type, text });
    setTimeout(() => setToastMessage(null), 4500);
  };

  const fetchDetail = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const res = await apiClient.getIntegrationDetail(id);
      setDetail(res);
      setError(null);
    } catch (err: any) {
      setError({
        status: err.status || 500,
        message: err.message || `Failed to load integration ${id}`,
      });
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  useRealtimeEvent(
    ['integration.health_changed', 'integration.sync_completed', 'integration.sync_failed'],
    (notification) => {
      if (!notification.resourceId || notification.resourceId === id) {
        fetchDetail();
      }
    },
    300,
  );

  const handleDisconnect = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await apiClient.disconnectIntegration(id);
      setShowDisconnectModal(false);
      showToast('success', 'Integration disconnected successfully.');
      await fetchDetail();
    } catch (err: any) {
      showToast('error', err.message || 'Failed to disconnect integration.');
      await fetchDetail();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReplaceKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setReplacementError(null);
    const key = replacementKey.trim();
    if (!key) {
      setReplacementError('API key is required.');
      return;
    }

    setIsSubmitting(true);
    try {
      await apiClient.replaceShipStationCredentials(id, key);
      setReplacementKey('');
      setShowReplaceModal(false);
      showToast('success', 'ShipStation credentials verified and updated.');
      await fetchDetail();
    } catch (err: any) {
      setReplacementError(err.message || 'Validation failed for replacement key.');
      await fetchDetail();
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-6 w-32 bg-[#ececeb] rounded animate-pulse" />
        <div className="p-6 bg-white rounded-xl border border-[#ececeb] space-y-4">
          <div className="h-8 w-2/3 bg-[#ececeb] rounded animate-pulse" />
          <div className="h-4 w-1/3 bg-[#ececeb] rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <MetricCardSkeleton />
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
          href="/integrations"
          className="inline-flex items-center gap-1 text-xs text-[#71717a] hover:text-[#18181b]"
        >
          <ArrowLeftIcon size={12} />
          <span>Back to Integrations</span>
        </Link>
        <ErrorState
          statusCode={error?.status || 404}
          message={error?.message || 'Integration not found'}
          onRetry={fetchDetail}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Toast Feedback */}
      {toastMessage && (
        <div
          className={`p-3.5 rounded-lg border text-xs flex items-center justify-between shadow-subtle animate-fadeIn ${
            toastMessage.type === 'success'
              ? 'bg-[#f0fdf4] border-[#bbf7d0] text-[#15803d]'
              : 'bg-[#fef2f2] border-[#fecaca] text-[#b91c1c]'
          }`}
        >
          <div className="flex items-center gap-2">
            {toastMessage.type === 'success' ? <CheckIcon size={14} /> : <AlertTriangleIcon size={14} />}
            <span>{toastMessage.text}</span>
          </div>
          <button onClick={() => setToastMessage(null)} className="text-current opacity-70 hover:opacity-100">
            <XIcon size={14} />
          </button>
        </div>
      )}

      {/* Navigation & Header Actions */}
      <div className="flex items-center justify-between">
        <Link
          href="/integrations"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-[#71717a] hover:text-[#18181b] transition-colors"
        >
          <ArrowLeftIcon size={13} />
          <span>Back to Integrations</span>
        </Link>

        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchDetail()}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-[#ececeb] text-xs font-medium text-[#18181b] hover:bg-[#fbfbfa] shadow-subtle transition-colors disabled:opacity-50"
          >
            <RefreshIcon size={12} className={isRefreshing ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>

          {isOwnerOrAdmin && detail.provider === 'SHIPSTATION' && detail.status !== 'DISCONNECTED' && (
            <button
              onClick={() => {
                setReplacementKey('');
                setReplacementError(null);
                setShowReplaceModal(true);
              }}
              className="px-3 py-1.5 rounded-lg bg-white border border-[#ececeb] text-[#18181b] hover:border-[#d4d4d8] text-xs font-medium transition-colors"
            >
              Replace Key
            </button>
          )}

          {isOwnerOrAdmin && detail.status !== 'DISCONNECTED' && (
            <button
              onClick={() => setShowDisconnectModal(true)}
              className="px-3 py-1.5 rounded-lg bg-white border border-[#fecaca] text-[#dc2626] hover:bg-[#fef2f2] text-xs font-medium transition-colors"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {/* Main Integration Card */}
      <div className="p-6 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#f4f4f5] pb-4">
          <div className="flex items-center gap-3">
            <ProviderIcon provider={detail.provider} />
            <div>
              <h1 className="text-lg font-bold text-[#18181b] tracking-tight">{detail.name}</h1>
              <p className="text-xs font-mono text-[#71717a]">
                {detail.provider === 'SHIPSTATION'
                  ? (detail.status === 'CONNECTED' ? 'Credential configured' : 'Not configured')
                  : detail.safeIdentifier}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <StatusBadge status={detail.status} size="sm" />
            <StatusBadge status={detail.health} size="sm" />
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[#f4f4f5] text-[#52525b] border border-[#e4e4e7]">
              Read only
            </span>
          </div>
        </div>

        {/* 4-Stat Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-1">
          <div className="p-3.5 rounded-lg bg-[#fbfbfa] border border-[#ececeb]">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#71717a]">
              Last Successful Sync
            </span>
            <p className="text-xs text-[#18181b] font-mono mt-1">
              {detail.lastSuccessfulSync
                ? new Date(detail.lastSuccessfulSync).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : 'Never'}
            </p>
          </div>

          <div className="p-3.5 rounded-lg bg-[#fbfbfa] border border-[#ececeb]">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#71717a]">
              Active Incidents
            </span>
            <p className="text-sm font-bold text-[#18181b] font-mono mt-0.5">
              {detail.activeCasesCount} active
            </p>
          </div>

          <div className="p-3.5 rounded-lg bg-[#fbfbfa] border border-[#ececeb]">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#71717a]">
              Historical Cases
            </span>
            <p className="text-sm font-bold text-[#18181b] font-mono mt-0.5">
              {detail.associatedCasesCount} total
            </p>
          </div>

          <div className="p-3.5 rounded-lg bg-[#fbfbfa] border border-[#ececeb]">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#71717a]">
              Capability Boundary
            </span>
            <p className="text-[11px] text-[#15803d] font-medium mt-1 flex items-center gap-1">
              <CheckIcon size={12} />
              <span>Read-Only Monitored</span>
            </p>
          </div>
        </div>

        {/* Last Error Banner if present */}
        {detail.lastError && (
          <div className="p-4 rounded-lg bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c] text-xs space-y-1">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertTriangleIcon size={14} />
              <span>Recent Error: {detail.lastError.category}</span>
            </div>
            <p className="text-[11px] text-[#991b1b]">{detail.lastError.summary}</p>
            <p className="text-[10px] text-[#7f1d1d]">
              Occurred: {new Date(detail.lastError.occurredAt).toLocaleString()}
            </p>
          </div>
        )}
      </div>

      {/* Recent Sync Jobs Table */}
      <div className="rounded-xl bg-white border border-[#ececeb] shadow-subtle p-5 space-y-3">
        <div className="flex items-center justify-between border-b border-[#f4f4f5] pb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
            Recent Synchronization Jobs ({detail.recentSyncJobs.length})
          </h3>
          <span className="text-[10px] font-mono text-[#a1a1aa]">Durable scheduler jobs</span>
        </div>

        {detail.recentSyncJobs.length === 0 ? (
          <p className="text-xs text-[#71717a] italic py-3">No sync jobs recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#ececeb] text-[#71717a] font-medium">
                  <th className="py-2 px-3">Job Type</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3">Attempts</th>
                  <th className="py-2 px-3">Enqueued</th>
                  <th className="py-2 px-3">Completed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f4f4f5]">
                {detail.recentSyncJobs.map((job) => (
                  <tr key={job.id} className="hover:bg-[#fbfbfa]">
                    <td className="py-2.5 px-3 font-mono text-[11px] text-[#18181b]">
                      {job.type}
                    </td>
                    <td className="py-2.5 px-3">
                      <StatusBadge status={job.status} size="sm" />
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[#71717a]">
                      {job.attemptCount}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-[#71717a]">
                      {new Date(job.createdAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-[#71717a]">
                      {job.completedAt
                        ? new Date(job.completedAt).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Safe Allowlisted Metadata Component */}
      <div className="rounded-xl bg-white border border-[#ececeb] shadow-subtle p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-[#f4f4f5] pb-2">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
              Safe Integration Metadata & Boundary Flags
            </h3>
            <p className="text-[11px] text-[#71717a] mt-0.5">
              Authoritative allowlisted metadata. All secrets and API credentials are strictly excluded from transmission and rendering.
            </p>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#f0fdf4] text-[#166534] border border-[#bbf7d0]">
            Allowlist Enforced
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] flex justify-between items-center">
            <span className="text-[#71717a] font-medium">Provider</span>
            <span className="font-mono text-[#18181b] font-semibold">{detail.provider}</span>
          </div>

          <div className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] flex justify-between items-center">
            <span className="text-[#71717a] font-medium">Canonical Identifier</span>
            <span className="font-mono text-[#18181b]">
              {detail.provider === 'SHIPSTATION'
                ? (detail.status === 'CONNECTED' ? 'Credential configured' : 'Not configured')
                : (typeof detail.safeConfiguration?.shopDomain === 'string'
                    ? detail.safeConfiguration.shopDomain
                    : detail.safeIdentifier || 'N/A')}
            </span>
          </div>

          <div className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] flex justify-between items-center">
            <span className="text-[#71717a] font-medium">Operational Mode</span>
            <span className="font-mono text-[#18181b] uppercase">
              {detail.mode} (Strict Read-Only)
            </span>
          </div>

          <div className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] flex justify-between items-center">
            <span className="text-[#71717a] font-medium">Sync Watermark</span>
            <span className="font-mono text-[#52525b] text-[11px]">
              {typeof detail.safeConfiguration?.syncWatermark === 'string'
                ? new Date(detail.safeConfiguration.syncWatermark).toLocaleString()
                : detail.lastSuccessfulSync
                ? new Date(detail.lastSuccessfulSync).toLocaleString()
                : 'No sync watermark'}
            </span>
          </div>
        </div>

        <div className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] space-y-2 text-xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#71717a]">
            Safe Capability Flags
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
            <div className="flex items-center gap-1.5 text-[#15803d]">
              <CheckIcon size={12} />
              <span>Read-Only Telemetry: Active</span>
            </div>
            <div className="flex items-center gap-1.5 text-[#15803d]">
              <CheckIcon size={12} />
              <span>Mutations Disabled: Enforced</span>
            </div>
            <div className="flex items-center gap-1.5 text-[#15803d]">
              <CheckIcon size={12} />
              <span>Secrets Redacted: AES-256 Envelope</span>
            </div>
          </div>
        </div>
      </div>

      {/* Disconnect Modal */}
      {showDisconnectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md bg-white rounded-xl border border-[#ececeb] shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[#f4f4f5] pb-2">
              <h4 className="text-sm font-semibold text-[#dc2626]">
                Disconnect {detail.name}
              </h4>
              <button
                onClick={() => setShowDisconnectModal(false)}
                disabled={isSubmitting}
                className="p-1 rounded-md text-[#71717a] hover:text-[#18181b]"
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="text-xs text-[#52525b] leading-relaxed">
              Disconnecting stops future synchronization. Past recovery logs, cases, and audit entries remain fully accessible.
            </p>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#f4f4f5]">
              <button
                type="button"
                onClick={() => setShowDisconnectModal(false)}
                disabled={isSubmitting}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[#e4e4e7] text-[#52525b] hover:bg-[#f4f4f5]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={isSubmitting}
                className="px-4 py-1.5 rounded-lg text-xs font-medium bg-[#dc2626] text-white hover:bg-[#b91c1c] transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {isSubmitting ? (
                  <>
                    <span className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                    <span>Disconnecting...</span>
                  </>
                ) : (
                  <span>Confirm Disconnect</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Replace Key Modal */}
      {showReplaceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md bg-white rounded-xl border border-[#ececeb] shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[#f4f4f5] pb-2">
              <h4 className="text-sm font-semibold text-[#18181b]">Replace ShipStation API Key</h4>
              <button
                onClick={() => {
                  setShowReplaceModal(false);
                  setReplacementKey('');
                  setReplacementError(null);
                }}
                disabled={isSubmitting}
                className="p-1 rounded-md text-[#71717a] hover:text-[#18181b]"
              >
                <XIcon size={16} />
              </button>
            </div>

            <form onSubmit={handleReplaceKey} className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-[#27272a]">
                  New API Key <span className="text-[#dc2626]">*</span>
                </label>
                <input
                  type="password"
                  value={replacementKey}
                  onChange={(e) => {
                    setReplacementKey(e.target.value);
                    if (replacementError) setReplacementError(null);
                  }}
                  placeholder="Enter replacement API Key"
                  autoComplete="new-password"
                  disabled={isSubmitting}
                  className={`w-full px-3 py-2 text-xs rounded-lg border font-mono ${
                    replacementError ? 'border-[#dc2626] bg-[#fef2f2]' : 'border-[#e4e4e7]'
                  } focus:outline-none focus:border-[#0070ba]`}
                />
                {replacementError && (
                  <p className="text-[11px] text-[#dc2626]">{replacementError}</p>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#f4f4f5]">
                <button
                  type="button"
                  onClick={() => {
                    setShowReplaceModal(false);
                    setReplacementKey('');
                    setReplacementError(null);
                  }}
                  disabled={isSubmitting}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[#e4e4e7] text-[#52525b] hover:bg-[#f4f4f5]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-1.5 rounded-lg text-xs font-medium bg-[#0070ba] text-white hover:bg-[#005a96] transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  {isSubmitting ? (
                    <>
                      <span className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                      <span>Validating...</span>
                    </>
                  ) : (
                    <span>Validate & Update</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
