import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandLockup } from '../brand/BrandLockup';

type AuthShellProps = {
  mode: 'login' | 'register';
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
};

const assurances = [
  ['01', 'Tenant isolated', 'Credentials and operational records remain organization-scoped.'],
  ['02', 'Approval guarded', 'Sensitive recovery actions stay behind explicit human authority.'],
  ['03', 'Evidence preserved', 'Every decision and provider response remains attached to the case.'],
];

export function AuthShell({ mode, eyebrow, title, description, children }: AuthShellProps) {
  const isLogin = mode === 'login';
  const supportingCopy = isLogin
    ? {
        label: 'SECURE WORKSPACE ACCESS',
        title: 'Return to your Reloop workspace.',
        description: 'Review Shopify, ShipStation, and warehouse mismatches as clear, traceable recovery cases.',
      }
    : {
        label: 'WORKSPACE SETUP',
        title: 'Set up your Reloop workspace.',
        description: 'Create an organization workspace where provider details, operator decisions, and recovery evidence stay connected.',
      };

  return (
    <main className="brand-noise min-h-screen overflow-hidden bg-reloop-canvas text-reloop-ink">
      <header className="border-b border-reloop-line bg-reloop-canvas/90 backdrop-blur-xl">
        <div className="mx-auto flex h-[76px] max-w-[1440px] items-center justify-between px-5 sm:px-8 lg:px-12">
          <Link href="/" aria-label="Reloop homepage">
            <span className="sm:hidden"><BrandLockup size="compact" priority /></span>
            <span className="hidden sm:inline-flex"><BrandLockup size="default" priority /></span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden text-[13px] text-reloop-muted sm:inline">
              {isLogin ? 'New to Reloop?' : 'Already operating with Reloop?'}
            </span>
            <Link href={isLogin ? '/register' : '/login'} className="brand-button brand-button-secondary min-h-[40px] px-4">
              {isLogin ? 'Create workspace' : 'Sign in'}
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto grid min-h-[calc(100vh-76px)] max-w-[1440px] border-x border-reloop-line lg:grid-cols-[1.05fr_.95fr]">
        <section className="relative flex min-h-[500px] flex-col justify-between overflow-hidden border-b border-reloop-line px-5 py-12 sm:px-10 sm:py-16 lg:min-h-0 lg:border-b-0 lg:border-r lg:px-12 lg:py-14 xl:px-16 xl:py-16">
          <div className="brand-grid absolute inset-0 opacity-55" aria-hidden="true" />
          <div className="absolute -right-32 top-20 h-80 w-80 rounded-full bg-reloop-signal/10 blur-3xl" aria-hidden="true" />

          <div className="relative max-w-[680px]">
            <div className="flex items-center gap-3">
              <img src="/brand/reloop-symbol.svg" alt="" className="h-5 w-5" />
              <span className="brand-data text-[11px] font-semibold tracking-[0.1em] text-reloop-signal-hover sm:text-xs">
                {supportingCopy.label}
              </span>
            </div>
            <h1 className="brand-display mt-8 max-w-[650px] text-[clamp(3.5rem,6vw,6.25rem)]">
              {supportingCopy.title}
            </h1>
            <p className="mt-7 max-w-[570px] text-base leading-8 text-reloop-muted sm:text-lg">
              {supportingCopy.description}
            </p>
          </div>

          <div className="relative mt-14 max-w-[680px] border border-reloop-line bg-reloop-surface/90 shadow-card backdrop-blur-sm lg:mt-10">
            <div className="flex items-center justify-between border-b border-reloop-line px-5 py-4">
              <span className="brand-data text-[10px] font-semibold tracking-[0.08em] text-reloop-muted sm:text-[11px]">OPERATING CONTRACT</span>
              <span className="flex items-center gap-2 brand-data text-[10px] font-semibold text-reloop-verified sm:text-[11px]">
                <span className="h-1.5 w-1.5 rounded-full bg-reloop-verified" /> ACTIVE
              </span>
            </div>
            <div className="grid sm:grid-cols-3">
              {assurances.map(([number, label, copy], index) => (
                <article key={number} className={`p-5 ${index < assurances.length - 1 ? 'border-b border-reloop-line sm:border-b-0 sm:border-r' : ''}`}>
                  <span className="brand-data text-[10px] text-reloop-signal-hover">{number}</span>
                  <h2 className="mt-7 text-sm font-semibold tracking-[-0.02em]">{label}</h2>
                  <p className="mt-2 text-xs leading-5 text-reloop-muted">{copy}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="flex items-center bg-reloop-paper px-5 py-12 sm:px-10 sm:py-16 lg:px-12 xl:px-20">
          <div className="mx-auto w-full max-w-[520px]">
            <div className="flex items-center justify-between border-b border-reloop-line pb-5">
              <span className="brand-data text-[11px] font-semibold tracking-[0.1em] text-reloop-signal-hover sm:text-xs">{eyebrow}</span>
              <span className="brand-data text-[10px] tracking-[0.06em] text-reloop-faint sm:text-[11px]">TLS / SESSION PROTECTED</span>
            </div>

            <h2 className="brand-display mt-9 text-[clamp(2.75rem,4.5vw,4.5rem)]">{title}</h2>
            <p className="mt-5 max-w-[470px] text-sm leading-7 text-reloop-muted sm:text-base">{description}</p>

            <div className="mt-9">{children}</div>

            <div className="mt-8 flex items-center justify-between border-t border-reloop-line pt-5 text-xs text-reloop-muted">
              <Link href={isLogin ? '/register' : '/login'} className="font-semibold text-reloop-ink transition-colors hover:text-reloop-signal-hover">
                {isLogin ? 'Create an organization ↗' : 'Use an existing workspace ↗'}
              </Link>
              <Link href="/" className="transition-colors hover:text-reloop-ink">Return home</Link>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
