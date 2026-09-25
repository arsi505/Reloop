import React from 'react';

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

  const sizeClasses =
    size === 'sm'
      ? 'text-[11px] px-2 py-0.5 font-medium'
      : 'text-xs px-2.5 py-1 font-medium';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-mono tracking-[0.02em] ${style.bg} ${style.text} ${style.border} ${sizeClasses} ${className}`}
    >
      {showDot && (
        <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      )}
      <span>{displayLabel}</span>
    </span>
  );
}

function formatStatusLabel(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
