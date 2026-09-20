'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ExceptionDetailDto } from '@reloop/contracts';
import { apiClient } from '../../lib/api-client';
import { useRealtimeEvent } from '../../context/realtime-context';
import { StatusBadge } from '../ui/StatusBadge';
import { Skeleton } from '../ui/Skeleton';
import { ErrorState } from '../ui/ErrorState';
import {
  ProviderIcon,
  ClockIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  ArrowRightIcon,
  ChevronDownIcon,
} from '../icons/Icons';
import { ApprovalPanel } from './ApprovalPanel';

interface ExceptionDetailViewProps {
  exceptionId: string;
  isDrawer?: boolean;
  onClose?: () => void;
}

export function ExceptionDetailView({
  exceptionId,
  isDrawer = false,
}: ExceptionDetailViewProps) {
  const [detail, setDetail] = useState<ExceptionDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusCode, setStatusCode] = useState<number | undefined>(undefined);
  const [showTechnicalEvidence, setShowTechnicalEvidence] = useState(false);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatusCode(undefined);

    try {
      const data = await apiClient.getExceptionDetail(exceptionId);
      setDetail(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load exception detail';
      setError(msg);
      if (msg.includes('401')) setStatusCode(401);
      else if (msg.includes('403')) setStatusCode(403);
      else if (msg.includes('404')) setStatusCode(404);
      else setStatusCode(500);
    } finally {
      setLoading(false);
    }
  }, [exceptionId]);

  const detailRef = React.useRef(detail);
  detailRef.current = detail;

  const refetchSilently = useCallback(async () => {
    try {
      const data = await apiClient.getExceptionDetail(exceptionId);
      setDetail(data);
    } catch {
      // Non-blocking background refetch error
    }
  }, [exceptionId]);

  useRealtimeEvent(
    [
      'exception.updated',
      'recovery.updated',
      'recovery.approval_decided',
    ],
    (notification) => {
      const currentDetail = detailRef.current;
      const matchesException =
        notification.resourceId === exceptionId ||
        (notification.resourceType === 'EXCEPTION' && notification.resourceId === exceptionId);
      const matchesWorkflow =
        currentDetail?.workflow?.id && notification.resourceId === currentDetail.workflow.id;
      const matchesApproval =
        currentDetail?.approval?.id && notification.resourceId === currentDetail.approval.id;

      if (matchesException || matchesWorkflow || matchesApproval) {
        refetchSilently();
      }
    },
    300,
  );

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  if (loading) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto p-2">
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <Skeleton className="h-8 w-96" />
        <div className="p-6 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="max-w-4xl mx-auto p-4 space-y-4">
        {!isDrawer && (
          <Link
            href="/exceptions"
            className="text-xs text-[#71717a] hover:text-[#18181b] flex items-center gap-1.5 font-medium mb-2"
          >
            ← Back to Exceptions
          </Link>
        )}
        <ErrorState
          statusCode={statusCode}
          message={error || 'Exception record not found.'}
          onRetry={fetchDetail}
        />
      </div>
    );
  }

  const isResolved = detail.status === 'RECOVERED' || detail.status === 'PARTIALLY_RECOVERED';
  const isBlocked = detail.status === 'BLOCKED' || detail.recoveryLevel === 'BLOCK';

  return (
    <div className={`space-y-6 max-w-4xl mx-auto ${isDrawer ? 'p-1' : ''}`}>
      {/* Navigation Breadcrumb / Back Link */}
      {!isDrawer && (
        <div className="flex items-center justify-between">
          <Link
            href="/exceptions"
            className="text-xs text-[#71717a] hover:text-[#18181b] flex items-center gap-1.5 font-medium transition-colors"
          >
            <span>← Back to Exceptions</span>
          </Link>
          <span className="font-mono text-xs text-[#a1a1aa]">
            ID: {detail.id}
          </span>
        </div>
      )}

      {/* Primary Incident Header Card */}
      <div className="p-6 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-[#f4f4f5] border border-[#e4e4e7] text-[#18181b]">
              {detail.type.replace(/_/g, ' ')}
            </span>
            <StatusBadge status={detail.status} size="sm" />
            <StatusBadge status={detail.recoveryLevel} size="sm" showDot={false} />
          </div>

          <div className="flex items-center gap-2 text-xs text-[#71717a]">
            <ClockIcon size={13} />
            <span>Detected: {new Date(detail.detectedAt).toLocaleString()}</span>
          </div>
        </div>

        {/* Problem Summary */}
        <div className="space-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
            Problem Summary
          </span>
          <h2 className="text-lg font-bold text-[#18181b] leading-snug">
            {detail.summary}
          </h2>
        </div>

        {/* Blocked Case Safety Alert (No execute action allowed!) */}
        {isBlocked && (
          <div className="p-3.5 rounded-lg bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c] text-xs flex items-center gap-2.5">
            <AlertCircleIcon size={16} className="text-[#ef4444] shrink-0" />
            <div>
              <p className="font-semibold">Automated Mutation Blocked by Policy</p>
              <p className="text-[11px] text-[#7f1d1d] mt-0.5">
                Execution is halted safely to prevent state corruption. Mutation requires manual operational authorization.
              </p>
            </div>
          </div>
        )}

        {/* Verified Resolution Information */}
        {isResolved && (
          <div className="p-3.5 rounded-lg bg-[#ecfdf5] border border-[#a7f3d0] text-[#047857] text-xs flex items-center gap-2.5">
            <CheckCircleIcon size={16} className="text-[#10b981] shrink-0" />
            <div>
              <p className="font-semibold">
                Integrity Verified & Resolved at{' '}
                {detail.resolvedAt ? new Date(detail.resolvedAt).toLocaleString() : 'N/A'}
              </p>
              {detail.recoveryResult && (
                <p className="text-[11px] text-[#065f46] mt-0.5">
                  Outcome: {detail.recoveryResult.outcome}{' '}
                  {detail.recoveryResult.details ? `— ${detail.recoveryResult.details}` : ''}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Grid: Order Reference & Connected Source Systems */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {/* Associated Order */}
        <div className="p-5 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
              Logical Order Reference
            </h3>
            {detail.order && (
              <Link
                href={`/orders/${detail.order.id}`}
                className="text-xs text-[#f95721] font-medium hover:underline flex items-center gap-1"
              >
                <span>View Order</span>
                <ArrowRightIcon size={11} />
              </Link>
            )}
          </div>

          {detail.order ? (
            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-1 border-b border-[#f4f4f5]">
                <span className="text-[#71717a]">Order Number</span>
                <span className="font-mono font-bold text-[#18181b]">
                  #{detail.order.orderNumber}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-[#f4f4f5]">
                <span className="text-[#71717a]">Order Status</span>
                <span className="font-medium text-[#18181b]">{detail.order.status}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-[#f4f4f5]">
                <span className="text-[#71717a]">Total Amount</span>
                <span className="font-medium text-[#18181b]">
                  {detail.order.currency || 'USD'} {detail.order.totalAmount || '0.00'}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-[#71717a]">Source Created At</span>
                <span className="text-[#18181b]">
                  {detail.order.sourceCreatedAt
                    ? new Date(detail.order.sourceCreatedAt).toLocaleDateString()
                    : 'N/A'}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-[#71717a] italic py-2">
              No logical order linked to this incident.
            </p>
          )}
        </div>

        {/* Source System & Integration */}
        <div className="p-5 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
            Source System Integration
          </h3>

          {detail.integration ? (
            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-1 border-b border-[#f4f4f5]">
                <span className="text-[#71717a]">Provider</span>
                <ProviderIcon provider={detail.integration.provider} />
              </div>
              <div className="flex justify-between py-1 border-b border-[#f4f4f5]">
                <span className="text-[#71717a]">Integration Name</span>
                <span className="font-medium text-[#18181b]">{detail.integration.name}</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-[#71717a]">Connection Status</span>
                <StatusBadge status={detail.integration.status} size="sm" />
              </div>
            </div>
          ) : (
            <p className="text-xs text-[#71717a] italic py-2">
              System-level synthetic exception.
            </p>
          )}
        </div>
      </div>

      {/* Operator Approval Section (reusable ApprovalPanel) */}
      {detail.approval && (
        <ApprovalPanel
          approval={detail.approval}
          onDecisionCompleted={fetchDetail}
        />
      )}

      {/* Workflow & Recovery Execution Steps */}
      {detail.workflowSteps && detail.workflowSteps.length > 0 && (
        <div className="p-5 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
              Recovery Execution Steps ({detail.workflowSteps.length})
            </h3>
            {detail.workflow && (
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-[#71717a]">
                  {detail.workflow.templateKey}
                </span>
                <StatusBadge status={detail.workflow.status} size="sm" />
              </div>
            )}
          </div>

          <div className="space-y-2 pt-1">
            {detail.workflowSteps.map((step) => (
              <div
                key={step.id}
                className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] flex items-center justify-between text-xs"
              >
                <div>
                  <p className="font-medium text-[#18181b]">{step.name}</p>
                  <p className="text-[10px] text-[#71717a] font-mono">{step.key}</p>
                </div>
                <StatusBadge status={step.status} size="sm" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Collapsed Technical Factual Evidence (Zero PII, No Raw JSON as Primary UI) */}
      <div className="rounded-xl bg-white border border-[#ececeb] shadow-subtle overflow-hidden">
        <button
          onClick={() => setShowTechnicalEvidence(!showTechnicalEvidence)}
          className="w-full p-4 flex items-center justify-between text-left hover:bg-[#fbfbfa] transition-colors"
        >
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
              Technical Diagnostic Evidence (Sanitized)
            </h3>
            <p className="text-[11px] text-[#71717a] mt-0.5">
              Deterministic evidence payload stripped of personal data.
            </p>
          </div>
          <ChevronDownIcon
            size={14}
            className={`text-[#71717a] transition-transform ${
              showTechnicalEvidence ? 'rotate-180' : ''
            }`}
          />
        </button>

        {showTechnicalEvidence && (
          <div className="p-4 border-t border-[#ececeb] bg-[#fbfbfa]">
            <pre className="font-mono text-[11px] text-[#52525b] overflow-x-auto leading-relaxed">
              {JSON.stringify(detail.sanitizedEvidence, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
