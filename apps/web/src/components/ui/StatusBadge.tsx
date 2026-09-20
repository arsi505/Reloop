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
      bg: 'bg-[#ecfdf5]',
      text: 'text-[#047857]',
      border: 'border-[#a7f3d0]',
      dot: 'bg-[#10b981]',
    },
    warning: {
      bg: 'bg-[#fffbeb]',
      text: 'text-[#b45309]',
      border: 'border-[#fde68a]',
      dot: 'bg-[#f59e0b]',
    },
    danger: {
      bg: 'bg-[#fef2f2]',
      text: 'text-[#b91c1c]',
      border: 'border-[#fecaca]',
      dot: 'bg-[#ef4444]',
    },
    info: {
      bg: 'bg-[#eff6ff]',
      text: 'text-[#1d4ed8]',
      border: 'border-[#bfdbfe]',
      dot: 'bg-[#3b82f6]',
    },
    neutral: {
      bg: 'bg-[#f4f4f5]',
      text: 'text-[#52525b]',
      border: 'border-[#e4e4e7]',
      dot: 'bg-[#71717a]',
    },
    brand: {
      bg: 'bg-[#fff5f1]',
      text: 'text-[#f95721]',
      border: 'border-[#ffdcd0]',
      dot: 'bg-[#f95721]',
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
      className={`inline-flex items-center gap-1.5 rounded-full border ${style.bg} ${style.text} ${style.border} ${sizeClasses} ${className}`}
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
