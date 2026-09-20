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
      <div className="w-10 h-10 rounded-full bg-[#f4f4f5] border border-[#e4e4e7] flex items-center justify-center text-[#71717a]">
        {icon || <CheckCircleIcon size={20} className="text-[#10b981]" />}
      </div>
      <div className="space-y-1 max-w-sm">
        <h4 className="text-sm font-semibold text-[#18181b]">{title}</h4>
        <p className="text-xs text-[#71717a] leading-relaxed">{description}</p>
      </div>
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
