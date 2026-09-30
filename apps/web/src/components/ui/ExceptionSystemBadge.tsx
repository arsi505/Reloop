import React from 'react';
import { ProviderIcon, ProviderMark } from '../icons/Icons';

type SystemRoute = {
  source: string;
  target: string;
  label: string;
};

function getSystemRoute(type: string, provider?: string | null): SystemRoute | null {
  if (type === 'TRACKING_MISSING_IN_SHOPIFY') {
    return { source: 'SHIPSTATION', target: 'SHOPIFY', label: 'ShipStation to Shopify' };
  }

  if (type === 'ORDER_MISSING_AT_3PL') {
    const target = provider && provider !== 'SHOPIFY' ? provider : 'GENERIC_3PL';
    return { source: 'SHOPIFY', target, label: `Shopify to ${formatProvider(target)}` };
  }

  if (type === 'SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY') {
    const source = provider && provider !== 'SHOPIFY' ? provider : 'GENERIC_3PL';
    return { source, target: 'SHOPIFY', label: `${formatProvider(source)} to Shopify` };
  }

  return null;
}

function formatProvider(provider: string): string {
  if (provider === 'GENERIC_3PL') return '3PL';
  if (provider === 'SHIPSTATION') return 'ShipStation';
  if (provider === 'SHOPIFY') return 'Shopify';
  if (provider === 'SIMULATOR') return 'test simulator';
  return provider;
}

export function ExceptionSystemBadge({ type, provider }: { type: string; provider?: string | null }) {
  const route = getSystemRoute(type, provider);

  if (!route) {
    return provider ? <ProviderIcon provider={provider} /> : <span className="text-reloop-faint">—</span>;
  }

  return (
    <span
      title={route.label}
      aria-label={route.label}
      className="inline-flex min-h-6 items-center gap-1.5 whitespace-nowrap rounded-md border border-reloop-line bg-reloop-paper px-2 py-1 text-reloop-muted shadow-subtle"
    >
      <ProviderMark provider={route.source} size={14} />
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-reloop-faint">
        <path d="M2 6h7M6.75 3.75 9 6 6.75 8.25" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <ProviderMark provider={route.target} size={14} />
      <span className="sr-only">{route.label}</span>
    </span>
  );
}
