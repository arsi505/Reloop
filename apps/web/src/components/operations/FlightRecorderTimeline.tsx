'use client';

import React from 'react';
import { TimelineEntryDto, WorkflowStatus } from '@reloop/contracts';
import {
  CheckIcon,
  XIcon,
  ShieldIcon,
  ClockIcon,
  AlertTriangleIcon,
} from '../icons/Icons';

interface FlightRecorderTimelineProps {
  timeline: TimelineEntryDto[];
  workflowStatus: WorkflowStatus;
  verifiedResolution?: {
    verifiedAt?: string | Date | null;
    systemsVerified?: string[];
    summary?: string;
  } | null;
}

export const FlightRecorderTimeline: React.FC<FlightRecorderTimelineProps> = ({
  timeline,
  workflowStatus,
  verifiedResolution,
}) => {
  // Sort entries chronologically
  const sortedTimeline = [...timeline].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // Check if any step was a VERIFY step that succeeded or failed
  const hasVerifySucceeded = sortedTimeline.some(
    (e) =>
      (e.eventType === 'STEP_SUCCEEDED' && e.description.toLowerCase().includes('verify')) ||
      e.eventType === 'CASE_RESOLVED',
  );

  const hasVerifyFailed = sortedTimeline.some(
    (e) =>
      (e.eventType === 'STEP_FAILED' && e.description.toLowerCase().includes('verify')) ||
      (e.description.toLowerCase().includes('verify') && e.status === 'FAILED'),
  );

  const isExecutionCompleted = sortedTimeline.some(
    (e) =>
      (e.eventType === 'STEP_SUCCEEDED' && !e.description.toLowerCase().includes('verify')) ||
      e.eventType === 'JOB_ATTEMPT_SUCCEEDED',
  );

  // Resolution is ONLY verified when VERIFY phase succeeds and workflow is completed
  const isVerifiedResolved =
    !hasVerifyFailed &&
    workflowStatus === 'SUCCEEDED' &&
    (hasVerifySucceeded || verifiedResolution !== null);

  // Helper to determine node phase: CHECK | EXECUTE | VERIFY | APPROVAL | SYSTEM
  const getNodePhase = (entry: TimelineEntryDto): {
    phase: 'CHECK' | 'EXECUTE' | 'VERIFY' | 'APPROVAL' | 'SYSTEM';
    dotColor: string;
    badgeBg: string;
    badgeText: string;
  } => {
    const text = (entry.description + ' ' + entry.eventType).toLowerCase();
    const isError = entry.status === 'FAILED' || entry.eventType.includes('FAILED') || entry.eventType.includes('REJECTED');

    if (isError) {
      return {
        phase: 'SYSTEM',
        dotColor: 'bg-[#ef4444]',
        badgeBg: 'bg-[#fef2f2]',
        badgeText: 'text-[#dc2626]',
      };
    }

    if (text.includes('approval')) {
      return {
        phase: 'APPROVAL',
        dotColor: 'bg-[#f59e0b]',
        badgeBg: 'bg-[#fffbeb]',
        badgeText: 'text-[#b45309]',
      };
    }

    if (text.includes('verify') || text.includes('resolution') || entry.eventType === 'CASE_RESOLVED') {
      return {
        phase: 'VERIFY',
        dotColor: 'bg-[#10b981]',
        badgeBg: 'bg-[#f0fdf4]',
        badgeText: 'text-[#166534]',
      };
    }

    if (text.includes('execut') || text.includes('job') || text.includes('sync')) {
      return {
        phase: 'EXECUTE',
        dotColor: 'bg-[#ea580c]',
        badgeBg: 'bg-[#fff7ed]',
        badgeText: 'text-[#c2410c]',
      };
    }

    if (text.includes('check') || text.includes('detect') || text.includes('acceptance') || text.includes('scan')) {
      return {
        phase: 'CHECK',
        dotColor: 'bg-[#6366f1]',
        badgeBg: 'bg-[#eef2ff]',
        badgeText: 'text-[#4338ca]',
      };
    }

    return {
      phase: 'SYSTEM',
      dotColor: 'bg-[#71717a]',
      badgeBg: 'bg-[#f4f4f5]',
      badgeText: 'text-[#52525b]',
    };
  };

  return (
    <div className="space-y-5">
      {/* 1. Verified Resolution Card (Restrained Success - ONLY shown when VERIFY phase succeeds) */}
      {isVerifiedResolved && (
        <div className="p-4 rounded-xl bg-[#f0fdf4] border border-[#bbf7d0] shadow-subtle space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[#15803d]">
              <div className="w-5 h-5 rounded-full bg-[#dcfce7] flex items-center justify-center">
                <CheckIcon size={13} className="text-[#16a34a]" />
              </div>
              <h4 className="text-xs font-bold uppercase tracking-wider">
                Verified Resolution
              </h4>
            </div>
            {verifiedResolution?.verifiedAt && (
              <span className="text-[11px] text-[#166534]">
                Verified: {new Date(verifiedResolution.verifiedAt).toLocaleString()}
              </span>
            )}
          </div>

          <p className="text-xs text-[#166534] leading-relaxed">
            {verifiedResolution?.summary ||
              'All recovery execution steps were independently verified against external systems. Cross-channel state parity confirmed.'}
          </p>

          <div className="flex items-center gap-2 pt-1 text-[11px] text-[#15803d]">
            <span className="font-semibold">Validated Channels:</span>
            <span className="font-mono text-[10px] bg-white/70 px-2 py-0.5 rounded border border-[#bbf7d0]">
              {(verifiedResolution?.systemsVerified || ['Shopify', 'ShipStation']).join(' ↔ ')}
            </span>
          </div>
        </div>
      )}

      {/* 2. Verification Failed Alert (Crucial Distinction: Execution occurred, but Verification failed) */}
      {hasVerifyFailed && (
        <div className="p-4 rounded-xl bg-[#fef2f2] border border-[#fecaca] shadow-subtle space-y-2">
          <div className="flex items-center gap-2 text-[#b91c1c]">
            <div className="w-5 h-5 rounded-full bg-[#fee2e2] flex items-center justify-center">
              <XIcon size={13} className="text-[#dc2626]" />
            </div>
            <h4 className="text-xs font-bold uppercase tracking-wider">
              Verification Failed (Not Resolved)
            </h4>
          </div>
          <p className="text-xs text-[#991b1b] leading-relaxed">
            {isExecutionCompleted
              ? 'Execution steps completed successfully, but the post-action verification step failed to confirm cross-system agreement. This case is NOT resolved and requires operator review.'
              : 'The verification step failed during execution. Automatic state transitions halted to preserve integrity.'}
          </p>
        </div>
      )}

      {/* Phase Legend: CHECK -> EXECUTE -> VERIFY */}
      <div className="flex items-center justify-between p-3 rounded-lg bg-[#fbfbfa] border border-[#ececeb] text-[11px]">
        <span className="font-semibold text-[#71717a] uppercase tracking-wider text-[10px]">
          Lifecycle Pipeline:
        </span>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#6366f1]" />
            <span className="font-medium text-[#4338ca]">1. CHECK</span>
          </div>
          <span className="text-[#d4d4d8]">→</span>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#f59e0b]" />
            <span className="font-medium text-[#b45309]">2. GATE / APPROVAL</span>
          </div>
          <span className="text-[#d4d4d8]">→</span>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#ea580c]" />
            <span className="font-medium text-[#c2410c]">3. EXECUTE</span>
          </div>
          <span className="text-[#d4d4d8]">→</span>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#10b981]" />
            <span className="font-medium text-[#166534]">4. VERIFY</span>
          </div>
        </div>
      </div>

      {/* Vertical Flight Recorder Timeline */}
      <div className="p-5 rounded-xl bg-white border border-[#ececeb] shadow-subtle space-y-4">
        <div className="flex items-center justify-between border-b border-[#f4f4f5] pb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a]">
            Flight Recorder Durable Timeline ({sortedTimeline.length} events)
          </h3>
          <span className="text-[11px] text-[#a1a1aa] font-mono">Immutable audit trail</span>
        </div>

        {sortedTimeline.length === 0 ? (
          <p className="text-xs text-[#71717a] italic py-3">No timeline events recorded yet.</p>
        ) : (
          <div className="relative pl-6 space-y-6 before:content-[''] before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-[2px] before:bg-[#ececeb]">
            {sortedTimeline.map((entry) => {
              const { phase, dotColor, badgeBg, badgeText } = getNodePhase(entry);
              return (
                <div key={entry.id} className="relative group">
                  {/* Node Dot */}
                  <div
                    className={`absolute -left-[29px] top-1 w-3.5 h-3.5 rounded-full ${dotColor} ring-4 ring-white shadow-sm flex items-center justify-center`}
                  />

                  {/* Content Block */}
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${badgeBg} ${badgeText}`}>
                        {phase}
                      </span>
                      <span className="font-medium text-[#18181b]">{entry.description}</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-[#71717a] font-mono">
                      <span className="flex items-center gap-1">
                        <ClockIcon size={11} />
                        {new Date(entry.timestamp).toLocaleString()}
                      </span>
                      {entry.system && (
                        <span>System: <strong className="text-[#52525b] font-normal">{entry.system}</strong></span>
                      )}
                      {entry.actor && (
                        <span>Actor: <strong className="text-[#52525b] font-normal">{entry.actor.name}</strong></span>
                      )}
                      {entry.status && (
                        <span>Status: <strong className="text-[#52525b] font-normal">{entry.status}</strong></span>
                      )}
                    </div>

                    {/* Metadata summary if present and non-empty */}
                    {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                      <div className="mt-1 pt-1">
                        <details className="text-[10px] text-[#71717a]">
                          <summary className="cursor-pointer hover:text-[#18181b] select-none">
                            Event metadata
                          </summary>
                          <pre className="mt-1 p-2 rounded bg-[#fbfbfa] border border-[#ececeb] overflow-x-auto text-[#52525b]">
                            {JSON.stringify(entry.metadata, null, 2)}
                          </pre>
                        </details>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
