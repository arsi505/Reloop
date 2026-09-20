'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { IntegrationCardDto, IntegrationProvider } from '@reloop/contracts';
import { apiClient, ApiError } from '../../lib/api-client';
import { useAuth } from '../../context/auth-context';
import { useRealtimeEvent } from '../../context/realtime-context';
import { StatusBadge } from '../ui/StatusBadge';
import { TableRowSkeleton } from '../ui/Skeleton';
import { ErrorState } from '../ui/ErrorState';
import { EmptyState } from '../ui/EmptyState';
import {
  ProviderIcon,
  RefreshIcon,
  PlusIcon,
  ArrowRightIcon,
  AlertTriangleIcon,
  CheckIcon,
  XIcon,
  IntegrationsIcon,
  ShieldIcon,
} from '../icons/Icons';

export const IntegrationsView: React.FC = () => {
  const router = useRouter();
  const { role } = useAuth();
  const [integrations, setIntegrations] = useState<IntegrationCardDto[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<{ status?: number; message?: string } | null>(null);

  // Modals state
  const [showShopifyModal, setShowShopifyModal] = useState(false);
  const [showShipStationModal, setShowShipStationModal] = useState(false);
  const [showReplaceKeyModal, setShowReplaceKeyModal] = useState<string | null>(null); // integrationId
  const [disconnectCandidate, setDisconnectCandidate] = useState<IntegrationCardDto | null>(null);

  // Form states
  const [shopifyDomain, setShopifyDomain] = useState('');
  const [shopifyError, setShopifyError] = useState<string | null>(null);
  const [shipstationKey, setShipstationKey] = useState('');
  const [shipstationError, setShipstationError] = useState<string | null>(null);
  const [replacementKey, setReplacementKey] = useState('');
  const [replacementError, setReplacementError] = useState<string | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const isOwnerOrAdmin = role === 'OWNER' || role === 'ADMIN';

  const showToast = (type: 'success' | 'error', text: string) => {
    setToastMessage({ type, text });
    setTimeout(() => {
      setToastMessage(null);
    }, 4500);
  };

  const fetchIntegrations = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient.getIntegrations();
      setIntegrations(res);
    } catch (err: any) {
      setError({
        status: err.status || 500,
        message: err.message || 'Failed to load integrations',
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchIntegrations();
  }, [fetchIntegrations]);

  useRealtimeEvent(['integration.health_changed', 'integration.sync_completed', 'integration.sync_failed'], () => {
    fetchIntegrations();
  });

  // Handle Connect Shopify
  const handleConnectShopify = async (e: React.FormEvent) => {
    e.preventDefault();
    setShopifyError(null);
    const domain = shopifyDomain.trim().toLowerCase();

    // Canonical shop validation
    const shopifyDomainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
    if (!shopifyDomainRegex.test(domain)) {
      setShopifyError('Please enter a valid canonical Shopify domain (e.g., your-store.myshopify.com)');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await apiClient.connectShopify(domain);
      setShowShopifyModal(false);
      setShopifyDomain('');
      showToast('success', `Redirecting to Shopify authorization for ${domain}...`);
      if (res.authorizationUrl) {
        window.location.href = res.authorizationUrl;
      }
    } catch (err: any) {
      setShopifyError(err.message || 'Failed to initiate Shopify connection.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle Connect ShipStation
  const handleConnectShipStation = async (e: React.FormEvent) => {
    e.preventDefault();
    setShipstationError(null);
    const key = shipstationKey.trim();

    if (!key) {
      setShipstationError('API Key is required.');
      return;
    }

    setIsSubmitting(true);
    try {
      await apiClient.connectShipStation(key);
      setShipstationKey(''); // Cleared immediately, never retained in storage
      setShowShipStationModal(false);
      showToast('success', 'ShipStation connected successfully.');
      await fetchIntegrations();
    } catch (err: any) {
      setShipstationError(err.message || 'Failed to connect ShipStation. Verify API key.');
      await fetchIntegrations();
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle Replace ShipStation Key
  const handleReplaceKey = async (integrationId: string) => {
    setReplacementError(null);
    const key = replacementKey.trim();

    if (!key) {
      setReplacementError('New API key is required.');
      return;
    }

    setIsSubmitting(true);
    try {
      await apiClient.replaceShipStationCredentials(integrationId, key);
      setReplacementKey(''); // Cleared immediately
      setShowReplaceKeyModal(null);
      showToast('success', 'ShipStation API key replaced and verified successfully.');
      await fetchIntegrations();
    } catch (err: any) {
      setReplacementError(err.message || 'Failed to validate replacement API key.');
      await fetchIntegrations();
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle Disconnect Integration
  const handleDisconnect = async () => {
    if (!disconnectCandidate || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await apiClient.disconnectIntegration(disconnectCandidate.id);
      showToast('success', `${disconnectCandidate.name} disconnected successfully.`);
      setDisconnectCandidate(null);
      await fetchIntegrations();
    } catch (err: any) {
      showToast('error', err.message || 'Failed to disconnect integration.');
      await fetchIntegrations();
    } finally {
      setIsSubmitting(false);
    }
  };

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
            {toastMessage.type === 'success' ? (
              <CheckIcon size={14} />
            ) : (
              <AlertTriangleIcon size={14} />
            )}
            <span>{toastMessage.text}</span>
          </div>
          <button onClick={() => setToastMessage(null)} className="text-current opacity-70 hover:opacity-100">
            <XIcon size={14} />
          </button>
        </div>
      )}

      {/* Header & Connection Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[#18181b]">
            Connected Integrations
          </h1>
          <p className="text-xs text-[#71717a] mt-0.5">
            Manage provider credentials, synchronization health, and read-only boundaries.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchIntegrations()}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-[#ececeb] text-xs font-medium text-[#18181b] hover:bg-[#fbfbfa] shadow-subtle transition-colors disabled:opacity-50"
          >
            <RefreshIcon size={12} className={isLoading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>

          {isOwnerOrAdmin && (
            <>
              <button
                onClick={() => {
                  setShopifyDomain('');
                  setShopifyError(null);
                  setShowShopifyModal(true);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#5e8e3e] text-white text-xs font-medium hover:bg-[#4d7532] shadow-subtle transition-colors"
              >
                <PlusIcon size={12} />
                <span>Connect Shopify</span>
              </button>

              <button
                onClick={() => {
                  setShipstationKey('');
                  setShipstationError(null);
                  setShowShipStationModal(true);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0070ba] text-white text-xs font-medium hover:bg-[#005a96] shadow-subtle transition-colors"
              >
                <PlusIcon size={12} />
                <span>Connect ShipStation</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Main Table / Surface */}
      <div className="rounded-xl bg-white border border-[#ececeb] shadow-subtle overflow-hidden">
        {error ? (
          <div className="p-6">
            <ErrorState
              statusCode={error.status}
              message={error.message}
              onRetry={fetchIntegrations}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[#ececeb] bg-[#fbfbfa]/75 text-[#71717a] font-medium select-none">
                  <th className="py-3 px-4">Provider</th>
                  <th className="py-3 px-4">Account / Identifier</th>
                  <th className="py-3 px-4">Health Status</th>
                  <th className="py-3 px-4">Mode</th>
                  <th className="py-3 px-4">Last Sync</th>
                  <th className="py-3 px-4">Last Safe Error</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f4f4f5]">
                {isLoading ? (
                  Array.from({ length: 3 }).map((_, idx) => (
                    <TableRowSkeleton key={idx} columns={7} />
                  ))
                ) : integrations.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12">
                      <EmptyState
                        title="No integrations connected"
                        description="Connect your primary Shopify store and ShipStation account to begin monitoring cross-channel integrity."
                        icon={<IntegrationsIcon size={20} />}
                        action={
                          isOwnerOrAdmin ? (
                            <button
                              onClick={() => setShowShopifyModal(true)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#f95721] hover:bg-[#ea4e1b] text-white text-xs font-medium transition-colors shadow-subtle"
                            >
                              <span>Connect Shopify</span>
                            </button>
                          ) : undefined
                        }
                      />
                    </td>
                  </tr>
                ) : (
                  integrations.map((item) => (
                    <tr
                      key={item.id}
                      className="hover:bg-[#fbfbfa] transition-colors group cursor-pointer"
                      onClick={() => router.push(`/integrations/${item.id}`)}
                    >
                      {/* Provider */}
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2">
                          <ProviderIcon provider={item.provider} />
                          <span className="font-semibold text-[#18181b]">{item.name}</span>
                        </div>
                      </td>

                      {/* Identifier */}
                      <td className="py-3.5 px-4 font-mono text-[11px] text-[#27272a]">
                        {item.provider === 'SHIPSTATION' ? (
                          item.status === 'CONNECTED' ? (
                            <span className="text-[#15803d] font-sans font-medium flex items-center gap-1.5">
                              <CheckIcon size={12} />
                              Credential configured
                            </span>
                          ) : (
                            <span className="text-[#71717a] font-sans">
                              Not configured
                            </span>
                          )
                        ) : (
                          item.safeIdentifier
                        )}
                      </td>

                      {/* Health Status */}
                      <td className="py-3.5 px-4">
                        <StatusBadge status={item.health} size="sm" />
                      </td>

                      {/* Mode: Strictly Read-Only */}
                      <td className="py-3.5 px-4">
                        <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[#f4f4f5] text-[#52525b] border border-[#e4e4e7]">
                          Read only
                        </span>
                      </td>

                      {/* Last Sync */}
                      <td className="py-3.5 px-4 text-[#71717a] font-mono text-[11px]">
                        {item.lastSuccessfulSync
                          ? new Date(item.lastSuccessfulSync).toLocaleString([], {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : 'Never'}
                      </td>

                      {/* Last Safe Error */}
                      <td className="py-3.5 px-4 max-w-xs truncate">
                        {item.lastError ? (
                          <div className="flex items-center gap-1.5 text-[#dc2626]" title={item.lastError.summary}>
                            <AlertTriangleIcon size={12} className="shrink-0" />
                            <span className="truncate text-[11px]">{item.lastError.summary}</span>
                          </div>
                        ) : (
                          <span className="text-[#15803d] text-[11px] flex items-center gap-1">
                            <CheckIcon size={12} />
                            <span>Healthy</span>
                          </span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-3.5 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="inline-flex items-center gap-2">
                          <Link
                            href={`/integrations/${item.id}`}
                            className="px-2.5 py-1 rounded bg-white border border-[#ececeb] text-[#71717a] hover:text-[#18181b] hover:border-[#d4d4d8] text-xs font-medium transition-colors"
                          >
                            Details
                          </Link>

                          {isOwnerOrAdmin && item.provider === 'SHIPSTATION' && item.status !== 'DISCONNECTED' && (
                            <button
                              type="button"
                              onClick={() => {
                                setReplacementKey('');
                                setReplacementError(null);
                                setShowReplaceKeyModal(item.id);
                              }}
                              className="px-2 py-1 rounded bg-white border border-[#ececeb] text-[#71717a] hover:text-[#18181b] hover:border-[#d4d4d8] text-xs transition-colors"
                            >
                              Replace Key
                            </button>
                          )}

                          {isOwnerOrAdmin && item.status !== 'DISCONNECTED' && (
                            <button
                              type="button"
                              onClick={() => setDisconnectCandidate(item)}
                              className="px-2 py-1 rounded text-[#dc2626] hover:bg-[#fef2f2] text-xs transition-colors"
                            >
                              Disconnect
                            </button>
                          )}

                          {isOwnerOrAdmin && item.status === 'DISCONNECTED' && (
                            <button
                              type="button"
                              onClick={() => {
                                if (item.provider === 'SHOPIFY') {
                                  setShopifyDomain(item.safeIdentifier);
                                  setShowShopifyModal(true);
                                } else {
                                  setShipstationKey('');
                                  setShowShipStationModal(true);
                                }
                              }}
                              className="px-2.5 py-1 rounded bg-[#fff0eb] text-[#f95721] hover:bg-[#ffdcd0] text-xs font-medium transition-colors"
                            >
                              Reconnect
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Connect Shopify Modal */}
      {showShopifyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md bg-white rounded-xl border border-[#ececeb] shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[#f4f4f5] pb-2">
              <div className="flex items-center gap-2">
                <ProviderIcon provider="SHOPIFY" />
                <h4 className="text-sm font-semibold text-[#18181b]">Connect Shopify Store</h4>
              </div>
              <button
                onClick={() => setShowShopifyModal(false)}
                disabled={isSubmitting}
                className="p-1 rounded-md text-[#71717a] hover:text-[#18181b]"
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="text-xs text-[#52525b] leading-relaxed">
              Connect your Shopify store using secure OAuth. Reloop requires read-only access to orders and fulfillment status. You will never be asked for raw access tokens.
            </p>

            <form onSubmit={handleConnectShopify} className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-[#27272a]">
                  Shopify Store Domain <span className="text-[#dc2626]">*</span>
                </label>
                <input
                  type="text"
                  value={shopifyDomain}
                  onChange={(e) => {
                    setShopifyDomain(e.target.value);
                    if (shopifyError) setShopifyError(null);
                  }}
                  placeholder="your-store.myshopify.com"
                  disabled={isSubmitting}
                  className={`w-full px-3 py-2 text-xs rounded-lg border ${
                    shopifyError ? 'border-[#dc2626] bg-[#fef2f2]' : 'border-[#e4e4e7]'
                  } focus:outline-none focus:border-[#5e8e3e]`}
                />
                {shopifyError && (
                  <p className="text-[11px] text-[#dc2626]">{shopifyError}</p>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#f4f4f5]">
                <button
                  type="button"
                  onClick={() => setShowShopifyModal(false)}
                  disabled={isSubmitting}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[#e4e4e7] text-[#52525b] hover:bg-[#f4f4f5]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-1.5 rounded-lg text-xs font-medium bg-[#5e8e3e] text-white hover:bg-[#4d7532] transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  {isSubmitting ? (
                    <>
                      <span className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                      <span>Initiating OAuth...</span>
                    </>
                  ) : (
                    <span>Authorize on Shopify</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Connect ShipStation Modal */}
      {showShipStationModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md bg-white rounded-xl border border-[#ececeb] shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[#f4f4f5] pb-2">
              <div className="flex items-center gap-2">
                <ProviderIcon provider="SHIPSTATION" />
                <h4 className="text-sm font-semibold text-[#18181b]">Connect ShipStation Account</h4>
              </div>
              <button
                onClick={() => {
                  setShowShipStationModal(false);
                  setShipstationKey('');
                  setShipstationError(null);
                }}
                disabled={isSubmitting}
                className="p-1 rounded-md text-[#71717a] hover:text-[#18181b]"
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="text-xs text-[#52525b] leading-relaxed">
              Enter your ShipStation API key. The key is encrypted immediately and never stored in plain text or browser storage. Reloop operates in strict read-only mode.
            </p>

            <form onSubmit={handleConnectShipStation} className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-[#27272a]">
                  ShipStation API Key <span className="text-[#dc2626]">*</span>
                </label>
                <input
                  type="password"
                  value={shipstationKey}
                  onChange={(e) => {
                    setShipstationKey(e.target.value);
                    if (shipstationError) setShipstationError(null);
                  }}
                  placeholder="Enter API Key"
                  autoComplete="new-password"
                  disabled={isSubmitting}
                  className={`w-full px-3 py-2 text-xs rounded-lg border font-mono ${
                    shipstationError ? 'border-[#dc2626] bg-[#fef2f2]' : 'border-[#e4e4e7]'
                  } focus:outline-none focus:border-[#0070ba]`}
                />
                {shipstationError && (
                  <p className="text-[11px] text-[#dc2626]">{shipstationError}</p>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#f4f4f5]">
                <button
                  type="button"
                  onClick={() => {
                    setShowShipStationModal(false);
                    setShipstationKey('');
                    setShipstationError(null);
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
                      <span>Validating Key...</span>
                    </>
                  ) : (
                    <span>Validate & Connect</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Replace ShipStation Key Modal */}
      {showReplaceKeyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md bg-white rounded-xl border border-[#ececeb] shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[#f4f4f5] pb-2">
              <h4 className="text-sm font-semibold text-[#18181b]">Replace ShipStation API Key</h4>
              <button
                onClick={() => {
                  setShowReplaceKeyModal(null);
                  setReplacementKey('');
                  setReplacementError(null);
                }}
                disabled={isSubmitting}
                className="p-1 rounded-md text-[#71717a] hover:text-[#18181b]"
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="text-xs text-[#52525b] leading-relaxed">
              Enter a new API key. Your existing key remains active until the new key is validated successfully against the ShipStation V2 API.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleReplaceKey(showReplaceKeyModal);
              }}
              className="space-y-3"
            >
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
                    setShowReplaceKeyModal(null);
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
                    <span>Validate & Replace</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Disconnect Confirmation Modal */}
      {disconnectCandidate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md bg-white rounded-xl border border-[#ececeb] shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[#f4f4f5] pb-2">
              <h4 className="text-sm font-semibold text-[#dc2626]">
                Disconnect {disconnectCandidate.name}
              </h4>
              <button
                onClick={() => setDisconnectCandidate(null)}
                disabled={isSubmitting}
                className="p-1 rounded-md text-[#71717a] hover:text-[#18181b]"
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="text-xs text-[#52525b] leading-relaxed">
              Disconnecting will stop future data synchronization and revoke active credentials.
            </p>

            <div className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] text-xs text-[#52525b] space-y-1">
              <p className="font-semibold text-[#18181b]">Historical data remains intact:</p>
              <p className="text-[11px]">
                Past recovery workflows, timeline logs, and cross-channel audit records will NOT be deleted.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#f4f4f5]">
              <button
                type="button"
                onClick={() => setDisconnectCandidate(null)}
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
    </div>
  );
};
