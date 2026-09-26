import type { ReactNode } from 'react';

type OperationalPageHeaderProps = {
  index: string;
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
};

export function OperationalPageHeader({ index, eyebrow, title, description, actions }: OperationalPageHeaderProps) {
  return (
    <header className="flex flex-col gap-6 border-b border-reloop-line pb-7 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex max-w-3xl gap-4 sm:gap-6">
        <span className="brand-data pt-1 text-[11px] font-semibold tracking-[0.08em] text-reloop-signal-hover">{index}</span>
        <div>
          <p className="brand-data text-[11px] font-semibold tracking-[0.09em] text-reloop-faint sm:text-xs">{eyebrow}</p>
          <h1 className="mt-3 font-display text-[clamp(2.25rem,3.6vw,3.85rem)] font-[620] leading-[0.96] tracking-[-0.05em] text-reloop-ink">{title}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-reloop-muted">{description}</p>
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

type RefreshControlProps = {
  loading: boolean;
  onClick: () => void;
  children?: ReactNode;
};

export function RefreshControl({ loading, onClick, children = 'Refresh data' }: RefreshControlProps) {
  return (
    <button onClick={onClick} disabled={loading} className="brand-button min-h-10 border border-reloop-line-strong bg-transparent px-3 text-reloop-ink hover:border-reloop-ink disabled:cursor-not-allowed disabled:opacity-50">
      <svg className={loading ? 'animate-spin' : ''} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" /></svg>
      <span>{children}</span>
    </button>
  );
}
