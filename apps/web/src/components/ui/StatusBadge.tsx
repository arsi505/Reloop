import React from 'react';
import {
  SearchIcon,
  ClockIcon,
  RefreshIcon,
  ShieldIcon,
  CheckCircleIcon,
  AlertCircleIcon,
} from '../icons/Icons';

type BadgeVariant =
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'neutral'
  | 'brand';

interface StatusBadgeProps {
  status: string;
  variant?: BadgeVariant;
  size?: 'sm' | 'md';
  showDot?: boolean;
  label?: string;
  className?: string;
}

export function StatusBadge({
  status,
  variant,
  size = 'sm',
  showDot = true,
  label,
  className = '',
}: StatusBadgeProps) {
  const normalized = status.toUpperCase().replace(/\s+/g, '_');

  let resolvedVariant: BadgeVariant = variant || 'neutral';

  if (!variant) {
    if (
      ['RESOLVED', 'RECOVERED', 'HEALTHY', 'COMPLETED', 'APPROVED', 'CONNECTED'].includes(
        normalized,
      )
    ) {
      resolvedVariant = 'success';
    } else if (
      [
        'REQUIRE_APPROVAL',
        'WAITING_APPROVAL',
        'DEGRADED',
        'PARTIALLY_RECOVERED',
        'PENDING',
        'SUSPENDED',
      ].includes(normalized)
    ) {
      resolvedVariant = 'warning';
    } else if (
      ['BLOCK', 'BLOCKED', 'FAILED', 'ERROR', 'REJECTED'].includes(normalized)
    ) {
      resolvedVariant = 'danger';
    } else if (
      [
        'AUTO_INVESTIGATE',
        'INVESTIGATING',
        'AUTO_RECOVER',
        'AUTO_RECOVERING',
        'RECOVERING',
        'RUNNING',
        'SYNCING',
      ].includes(normalized)
    ) {
      resolvedVariant = 'info';
    } else if (['DISCONNECTED', 'CANCELLED', 'IGNORED', 'CLOSED', 'EXPIRED'].includes(normalized)) {
      resolvedVariant = 'neutral';
    }
  }

  const variantStyles: Record<BadgeVariant, { bg: string; text: string; border: string; dot: string }> = {
    success: {
      bg: 'bg-reloop-verified-soft',
      text: 'text-reloop-verified',
      border: 'border-reloop-verified/20',
      dot: 'bg-reloop-verified',
    },
    warning: {
      bg: 'bg-reloop-warning-soft',
      text: 'text-reloop-warning',
      border: 'border-reloop-warning/20',
      dot: 'bg-reloop-warning',
    },
    danger: {
      bg: 'bg-reloop-critical-soft',
      text: 'text-reloop-critical',
      border: 'border-reloop-critical/20',
      dot: 'bg-reloop-critical',
    },
    info: {
      bg: 'bg-[#e7f1f5]',
      text: 'text-[#315e73]',
      border: 'border-[#315e73]/20',
      dot: 'bg-[#315e73]',
    },
    neutral: {
      bg: 'bg-reloop-paper',
      text: 'text-reloop-muted',
      border: 'border-reloop-line',
      dot: 'bg-reloop-faint',
    },
    brand: {
      bg: 'bg-reloop-signal-soft',
      text: 'text-reloop-signal-hover',
      border: 'border-reloop-signal/25',
      dot: 'bg-reloop-signal',
    },
  };

  const style = variantStyles[resolvedVariant];
  const displayLabel = label || formatStatusLabel(status);
  const recoveryIcon = getRecoveryIcon(normalized);

  const sizeClasses =
    size === 'sm'
      ? 'min-h-6 px-2.5 py-1 text-[11px] font-semibold leading-none'
      : 'min-h-7 px-3 py-1.5 text-xs font-semibold leading-none';

  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-md border tracking-[-0.01em] ${style.bg} ${style.text} ${style.border} ${sizeClasses} ${className}`}
    >
      {!showDot && recoveryIcon}
      {showDot && getStatusDotIcon(resolvedVariant, normalized)}
      <span>{displayLabel}</span>
    </span>
  );
}

function formatStatusLabel(str: string): string {
  if (!str) return '';

  const normalized = str.toUpperCase().replace(/\s+/g, '_');
  const conciseLabels: Record<string, string> = {
    AUTO_RECOVERING: 'Recovering',
    WAITING_APPROVAL: 'Awaiting approval',
  };

  if (conciseLabels[normalized]) return conciseLabels[normalized];

  return str
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function getRecoveryIcon(normalized: string): React.ReactNode {
  if (['AUTO_RECOVER', 'SAFE_AUTO_RECOVERY', 'AUTO_INVESTIGATE'].includes(normalized)) {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none">
        <path d="M9.2 1.75 3.75 8.4h3.68l-.62 5.85 5.44-7.03H8.7l.5-5.47Z" fill="currentColor" />
      </svg>
    );
  }

  if (normalized === 'REQUIRE_APPROVAL') {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 1.8 13 3.7v3.6c0 3.1-2.05 5.65-5 6.9-2.95-1.25-5-3.8-5-6.9V3.7L8 1.8Z" />
        <path d="m5.75 7.95 1.45 1.4 3.05-3.05" />
      </svg>
    );
  }

  return null;
}

function getStatusDotIcon(variant: BadgeVariant, normalized: string): React.ReactNode {
  const iconSize = 11;
  const cls = 'shrink-0';

  // Status-specific overrides first
  if (['AUTO_INVESTIGATE', 'INVESTIGATING'].includes(normalized)) {
    return <SearchIcon size={iconSize} className={cls} />;
  }
  if (['AUTO_RECOVER', 'AUTO_RECOVERING', 'RECOVERING', 'RUNNING', 'SYNCING'].includes(normalized)) {
    return <RefreshIcon size={iconSize} className={cls} />;
  }
  if (['OPEN'].includes(normalized)) {
    return <AlertCircleIcon size={iconSize} className={cls} />;
  }

  // Variant-level fallbacks
  if (variant === 'success') {
    return <CheckCircleIcon size={iconSize} className={cls} />;
  }
  if (variant === 'warning') {
    return <ClockIcon size={iconSize} className={cls} />;
  }
  if (variant === 'danger') {
    return <ShieldIcon size={iconSize} className={cls} />;
  }
  if (variant === 'info') {
    return <RefreshIcon size={iconSize} className={cls} />;
  }

  // Neutral / unknown — small circle fallback
  return <AlertCircleIcon size={iconSize} className={cls} />;
}
