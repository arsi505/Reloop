'use client';

import React, { useState } from 'react';
import { StatusBadge } from '../ui/StatusBadge';
import { useAuth } from '../../context/auth-context';
import { apiClient, ApiError } from '../../lib/api-client';
import { CheckIcon, AlertTriangleIcon, XIcon, ShieldIcon } from '../icons/Icons';
import { ApprovalStatus } from '@reloop/contracts';

export interface ApprovalData {
  id: string;
  status: ApprovalStatus | string;
  reason?: string | null;
  requestedAt?: string | Date;
  decidedAt?: string | Date | null;
  expiresAt?: string | Date | null;
  previewSnapshot?: Record<string, any> | null;
}

interface ApprovalPanelProps {
  approval: ApprovalData;
  onDecisionCompleted: () => Promise<void> | void;
}

export const ApprovalPanel: React.FC<ApprovalPanelProps> = ({
  approval,
  onDecisionCompleted,
}) => {
  const { role } = useAuth();
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [approvalNote, setApprovalNote] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);

  const canDecide = role === 'OWNER' || role === 'ADMIN' || role === 'OPERATOR';
  const isViewer = role === 'VIEWER';
  const isPending = approval.status === 'PENDING';

  // Extract structured preview snapshot fields if available
  const preview = approval.previewSnapshot || {};
  const problem = preview.problem || preview.targetSystem || 'Commercial state discrepancy';
  const proposedAction = preview.action || preview.proposedAction || 'Execute recovery workflow';
  const why = preview.why || preview.reason || 'Resolves detected desync between primary commerce channels.';
  const safetyChecks = Array.isArray(preview.safetyChecks) ? preview.safetyChecks : [];
  const changes = Array.isArray(preview.changes)
    ? preview.changes
    : preview.changes && typeof preview.changes === 'object'
    ? Object.entries(preview.changes).map(([k, v]) => `${k}: ${v}`)
    : [];
  const nonChanges = Array.isArray(preview.nonChanges) ? preview.nonChanges : [];
  const verification = preview.verification || preview.verificationStrategy;
  const risks = Array.isArray(preview.risks) ? preview.risks : [];

  const handleApprove = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setConflictMessage(null);
    setGeneralError(null);

    try {
      await apiClient.approveApproval(approval.id, approvalNote.trim() || undefined);
      setShowApproveModal(false);
      setApprovalNote('');
      await onDecisionCompleted();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setConflictMessage(
            'This approval has already been decided by another operator or is no longer pending.',
          );
          setShowApproveModal(false);
          await onDecisionCompleted();
          return;
        }
        if (err.status === 403) {
          setGeneralError('Permission denied. Your role is not authorized to decide approvals.');
          return;
        }
        setGeneralError(err.message || 'Failed to approve recovery action.');
      } else {
        setGeneralError('A network or server error occurred. Refreshing authoritative state...');
        await onDecisionCompleted();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (isSubmitting) return;
    const trimmed = rejectionReason.trim();
    if (!trimmed) {
      setReasonError('Rejection reason is required by audit policy.');
      return;
    }

    setIsSubmitting(true);
    setConflictMessage(null);
    setGeneralError(null);

    try {
      await apiClient.rejectApproval(approval.id, trimmed);
      setShowRejectModal(false);
      setRejectionReason('');
      setReasonError(null);
      await onDecisionCompleted();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setConflictMessage(
            'This approval has already been decided by another operator or is no longer pending.',
          );
          setShowRejectModal(false);
          await onDecisionCompleted();
          return;
        }
        if (err.status === 403) {
          setGeneralError('Permission denied. Your role is not authorized to decide approvals.');
          return;
        }
        setGeneralError(err.message || 'Failed to reject recovery action.');
      } else {
        setGeneralError('A network or server error occurred. Refreshing authoritative state...');
        await onDecisionCompleted();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-5 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#f4f4f5] pb-3">
        <div className="flex items-center gap-2">
          <ShieldIcon size={16} className="text-[#f95721]" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
            Operator Approval Request
          </h3>
        </div>
        <StatusBadge status={approval.status} size="sm" />
      </div>

      {/* Conflict / Stale Decision Message */}
      {conflictMessage && (
        <div className="p-3 bg-[#fff7ed] border border-[#ffedd5] rounded-lg text-[#c2410c] text-xs flex items-start gap-2">
          <AlertTriangleIcon size={16} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Approval State Updated</p>
            <p className="text-[11px] mt-0.5">{conflictMessage}</p>
          </div>
        </div>
      )}

      {/* General Error Message */}
      {generalError && (
        <div className="p-3 bg-[#fef2f2] border border-[#fee2e2] rounded-lg text-[#b91c1c] text-xs flex items-start gap-2">
          <AlertTriangleIcon size={16} className="shrink-0 mt-0.5" />
          <p className="text-[11px] mt-0.5">{generalError}</p>
        </div>
      )}

      {/* Status Notice */}
      {isPending && (
        <div className="p-3 bg-[#fffbeb] border border-[#fde68a] rounded-lg text-[#b45309] text-xs">
          <p className="font-semibold">Human Operator Gate Required</p>
          <p className="text-[11px] mt-0.5">
            {approval.reason || 'This recovery action mutates commercial records and requires human verification.'}
          </p>
          <div className="mt-2 text-[10px] text-[#92400e] flex flex-wrap gap-3">
            {approval.requestedAt && (
              <span>Requested: {new Date(approval.requestedAt).toLocaleString()}</span>
            )}
            {approval.expiresAt && (
              <span>Expires: {new Date(approval.expiresAt).toLocaleString()}</span>
            )}
          </div>
        </div>
      )}

      {approval.status === 'APPROVED' && (
        <div className="p-3 bg-[#f0fdf4] border border-[#bbf7d0] rounded-lg text-[#15803d] text-xs">
          <div className="flex items-center gap-1.5 font-semibold">
            <CheckIcon size={14} />
            <span>Recovery Approved by Authorized Operator</span>
          </div>
          {approval.decidedAt && (
            <p className="text-[11px] mt-0.5 text-[#166534]">
              Decided: {new Date(approval.decidedAt).toLocaleString()}
            </p>
          )}
          {approval.reason && (
            <p className="text-[11px] mt-1 text-[#166534] italic font-sans">
              Approval note: {approval.reason}
            </p>
          )}
        </div>
      )}

      {approval.status === 'REJECTED' && (
        <div className="p-3 bg-[#fef2f2] border border-[#fecaca] rounded-lg text-[#b91c1c] text-xs">
          <div className="flex items-center gap-1.5 font-semibold">
            <XIcon size={14} />
            <span>Recovery Rejected by Operator</span>
          </div>
          {approval.decidedAt && (
            <p className="text-[11px] mt-0.5 text-[#991b1b]">
              Decided: {new Date(approval.decidedAt).toLocaleString()}
            </p>
          )}
          <p className="text-[11px] mt-1 font-medium text-[#991b1b]">
            Rejection reason: {approval.reason || 'No specific reason entered.'}
          </p>
          <p className="text-[10px] mt-1 text-[#7f1d1d] italic">
            Downstream execution steps have been aborted to preserve external integrity.
          </p>
        </div>
      )}

      {/* Immutable Preview Snapshot Details */}
      {approval.previewSnapshot && (
        <div className="space-y-3 pt-1 text-xs">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#71717a]">
                Target System & Action
              </span>
              <p className="font-semibold text-[#18181b]">{proposedAction}</p>
              <p className="text-[11px] text-[#52525b]">{problem}</p>
            </div>
            <div className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#71717a]">
                Rationale
              </span>
              <p className="text-[11px] text-[#52525b]">{why}</p>
            </div>
          </div>

          {/* Planned Changes & Safety Checks */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {changes.length > 0 && (
              <div className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#71717a]">
                  Proposed Modifications
                </span>
                <ul className="list-disc list-inside space-y-0.5 text-[11px] text-[#27272a]">
                  {changes.map((change: string, idx: number) => (
                    <li key={idx}>{change}</li>
                  ))}
                </ul>
              </div>
            )}

            {safetyChecks.length > 0 && (
              <div className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#71717a]">
                  Pre-Execution Safety Checks
                </span>
                <ul className="list-disc list-inside space-y-0.5 text-[11px] text-[#27272a]">
                  {safetyChecks.map((check: string, idx: number) => (
                    <li key={idx}>{check}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Verification Strategy & Risks */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {verification && (
              <div className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#10b981]">
                  Post-Action Verification
                </span>
                <p className="text-[11px] text-[#52525b]">{verification}</p>
              </div>
            )}

            {risks.length > 0 && (
              <div className="p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#b45309]">
                  Evaluated Risks
                </span>
                <ul className="list-disc list-inside space-y-0.5 text-[11px] text-[#b45309]">
                  {risks.map((risk: string, idx: number) => (
                    <li key={idx}>{risk}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Full Collapsible Raw Snapshot */}
          <details className="text-[11px] pt-1">
            <summary className="cursor-pointer text-[#71717a] hover:text-[#18181b] font-medium select-none">
              View Complete Immutable Snapshot Payload
            </summary>
            <pre className="mt-2 p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] font-mono text-[10px] text-[#52525b] overflow-x-auto leading-relaxed">
              {JSON.stringify(approval.previewSnapshot, null, 2)}
            </pre>
          </details>
        </div>
      )}

      {/* Role Notice & Operator Action Controls */}
      {isPending && (
        <div className="pt-2 border-t border-[#f4f4f5]">
          {isViewer ? (
            <div className="p-2.5 rounded-lg bg-[#f4f4f5] border border-[#e4e4e7] text-[#71717a] text-xs">
              <p className="font-medium">Read-Only Access</p>
              <p className="text-[11px] mt-0.5">
                Your role (VIEWER) cannot decide approvals. Contact an OWNER, ADMIN, or OPERATOR.
              </p>
            </div>
          ) : canDecide ? (
            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setRejectionReason('');
                  setReasonError(null);
                  setShowRejectModal(true);
                }}
                disabled={isSubmitting}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium border border-[#e4e4e7] bg-white text-[#52525b] hover:text-[#dc2626] hover:border-[#fca5a5] hover:bg-[#fef2f2] transition-colors disabled:opacity-50"
              >
                Reject Recovery
              </button>

              <button
                type="button"
                onClick={() => {
                  setApprovalNote('');
                  setShowApproveModal(true);
                }}
                disabled={isSubmitting}
                className="px-4 py-1.5 rounded-lg text-xs font-medium bg-[#f95721] text-white hover:bg-[#ea580c] shadow-subtle transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                <span>Approve Recovery</span>
              </button>
            </div>
          ) : null}
        </div>
      )}

      {/* Approve Confirmation Modal */}
      {showApproveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md bg-white rounded-xl border border-[#ececeb] shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[#f4f4f5] pb-2">
              <h4 className="text-sm font-semibold text-[#18181b]">Confirm Recovery Approval</h4>
              <button
                onClick={() => setShowApproveModal(false)}
                disabled={isSubmitting}
                className="p-1 rounded-md text-[#71717a] hover:text-[#18181b]"
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="text-xs text-[#52525b] leading-relaxed">
              You are authorizing execution of the proposed mutation. This will advance the workflow to the execution phase and trigger verification against external systems.
            </p>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#27272a]">
                Approval Note (Optional)
              </label>
              <textarea
                value={approvalNote}
                onChange={(e) => setApprovalNote(e.target.value)}
                placeholder="Optional context or ticket reference for audit trail..."
                rows={2}
                disabled={isSubmitting}
                className="w-full p-2 text-xs rounded-lg border border-[#e4e4e7] focus:outline-none focus:border-[#f95721] resize-none"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#f4f4f5]">
              <button
                type="button"
                onClick={() => setShowApproveModal(false)}
                disabled={isSubmitting}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[#e4e4e7] text-[#52525b] hover:bg-[#f4f4f5]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApprove}
                disabled={isSubmitting}
                className="px-4 py-1.5 rounded-lg text-xs font-medium bg-[#f95721] text-white hover:bg-[#ea580c] transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {isSubmitting ? (
                  <>
                    <span className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                    <span>Authorizing...</span>
                  </>
                ) : (
                  <span>Confirm Approval</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject Confirmation Modal */}
      {showRejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md bg-white rounded-xl border border-[#ececeb] shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[#f4f4f5] pb-2">
              <h4 className="text-sm font-semibold text-[#b91c1c]">Reject Recovery Action</h4>
              <button
                onClick={() => setShowRejectModal(false)}
                disabled={isSubmitting}
                className="p-1 rounded-md text-[#71717a] hover:text-[#18181b]"
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="text-xs text-[#52525b] leading-relaxed">
              Rejecting this approval permanently halts the workflow and prevents any downstream modifications to external systems. A reason is strictly required.
            </p>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#27272a] flex items-center justify-between">
                <span>Rejection Reason <span className="text-[#dc2626]">*</span></span>
              </label>
              <textarea
                value={rejectionReason}
                onChange={(e) => {
                  setRejectionReason(e.target.value);
                  if (reasonError) setReasonError(null);
                }}
                placeholder="Explain why this recovery action is being rejected..."
                rows={3}
                disabled={isSubmitting}
                className={`w-full p-2 text-xs rounded-lg border ${
                  reasonError ? 'border-[#dc2626] bg-[#fef2f2]' : 'border-[#e4e4e7]'
                } focus:outline-none focus:border-[#dc2626] resize-none`}
              />
              {reasonError && (
                <p className="text-[11px] text-[#dc2626]">{reasonError}</p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#f4f4f5]">
              <button
                type="button"
                onClick={() => setShowRejectModal(false)}
                disabled={isSubmitting}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[#e4e4e7] text-[#52525b] hover:bg-[#f4f4f5]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleReject}
                disabled={isSubmitting}
                className="px-4 py-1.5 rounded-lg text-xs font-medium bg-[#dc2626] text-white hover:bg-[#b91c1c] transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {isSubmitting ? (
                  <>
                    <span className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                    <span>Rejecting...</span>
                  </>
                ) : (
                  <span>Confirm Rejection</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
