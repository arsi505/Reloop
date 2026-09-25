import React from 'react';
import { CheckCircleIcon } from '../icons/Icons';

interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  title = 'No records found',
  description = 'There are no active items matching this criteria.',
  icon,
  action,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={`py-12 px-6 flex flex-col items-center justify-center text-center space-y-2.5 ${className}`}
    >
      <div className="w-11 h-11 rounded-control bg-reloop-paper border border-reloop-line flex items-center justify-center text-reloop-muted shadow-subtle">
        {icon || <CheckCircleIcon size={20} className="text-reloop-verified" />}
      </div>
      <div className="space-y-1 max-w-sm">
        <h4 className="text-sm font-semibold text-reloop-ink tracking-[-0.015em]">{title}</h4>
        <p className="text-xs text-reloop-muted leading-relaxed">{description}</p>
      </div>
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
