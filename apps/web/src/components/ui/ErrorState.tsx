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
      className={`p-6 rounded-brand bg-reloop-surface border border-reloop-critical/25 shadow-card text-left space-y-3 ${className}`}
    >
      <div className="flex items-center gap-2.5 text-reloop-critical">
        <AlertCircleIcon size={18} className="shrink-0" />
        <h3 className="font-semibold text-sm text-reloop-ink">{displayTitle}</h3>
      </div>
      <p className="text-xs text-reloop-muted leading-relaxed">{displayMessage}</p>
      {onRetry && (
        <div className="pt-2">
          <button
            onClick={onRetry}
            className="brand-button brand-button-secondary min-h-0 py-1.5 text-xs"
          >
            <RefreshIcon size={12} className="text-reloop-muted" />
            <span>Retry Operation</span>
          </button>
        </div>
      )}
    </div>
  );
}
