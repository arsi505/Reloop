import React from 'react';
import { AlertCircleIcon, RefreshIcon } from '../icons/Icons';

interface ErrorStateProps {
  title?: string;
  message?: string;
  statusCode?: number;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title,
  message,
  statusCode,
  onRetry,
  className = '',
}: ErrorStateProps) {
  let displayTitle = title;
  let displayMessage = message || 'An unexpected operational error occurred.';

  if (statusCode === 401) {
    displayTitle = displayTitle || 'Authentication Required';
    displayMessage = 'Your session has expired or is invalid. Please sign in again.';
  } else if (statusCode === 403) {
    displayTitle = displayTitle || 'Access Restricted';
    displayMessage = 'You do not have the necessary organization role to view this resource.';
  } else if (statusCode === 404) {
    displayTitle = displayTitle || 'Resource Not Found';
    displayMessage = 'The requested operational record does not exist in your organization.';
  } else if (statusCode === 500) {
    displayTitle = displayTitle || 'Service Unavailable';
    displayMessage = 'Backend service encountered an error. Safe isolation active; please retry.';
  } else {
    displayTitle = displayTitle || 'Unable to Load Data';
  }

  return (
    <div
      className={`p-6 rounded-xl bg-white border border-[#fecaca] shadow-subtle text-left space-y-3 ${className}`}
    >
      <div className="flex items-center gap-2.5 text-[#b91c1c]">
        <AlertCircleIcon size={18} className="shrink-0 text-[#ef4444]" />
        <h3 className="font-semibold text-sm text-[#18181b]">{displayTitle}</h3>
      </div>
      <p className="text-xs text-[#71717a] leading-relaxed">{displayMessage}</p>
      {onRetry && (
        <div className="pt-2">
          <button
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#f4f4f5] hover:bg-white text-xs font-medium text-[#18181b] border border-[#ececeb] transition-colors shadow-subtle"
          >
            <RefreshIcon size={12} className="text-[#71717a]" />
            <span>Retry Operation</span>
          </button>
        </div>
      )}
    </div>
  );
}
