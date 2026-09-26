'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BrandLockup } from '../brand/BrandLockup';

function ArrowUpRight() {
  return (
    <svg className="brand-button-icon" width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M4 11L11 4M5 4H11V10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function MarketingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY >= 14);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [mobileOpen]);

  const closeMobileMenu = () => setMobileOpen(false);

  return (
    <>
    <header className={`marketing-header sticky top-0 z-50 ${scrolled ? 'is-scrolled' : ''}`}>
      <div className="mx-auto flex h-[66px] max-w-[1440px] items-center justify-between px-5 sm:h-[76px] sm:px-8 lg:px-12">
        <Link href="/" aria-label="Reloop homepage" className="shrink-0">
          <span className="sm:hidden"><BrandLockup size="compact" priority /></span>
          <span className="hidden sm:inline-flex"><BrandLockup size="default" priority /></span>
        </Link>

        <nav aria-label="Primary navigation" className="hidden items-center gap-8 lg:flex">
          <Link href="#product" className="brand-link-line text-sm font-semibold text-reloop-muted transition-colors hover:text-reloop-ink">Product</Link>
          <Link href="#how-it-works" className="brand-link-line text-sm font-semibold text-reloop-muted transition-colors hover:text-reloop-ink">How it works</Link>
          <Link href="#integrations" className="brand-link-line text-sm font-semibold text-reloop-muted transition-colors hover:text-reloop-ink">Integrations</Link>
          <Link href="#pricing" className="brand-link-line text-sm font-semibold text-reloop-muted transition-colors hover:text-reloop-ink">Pricing</Link>
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <Link href="/login" className="px-3 py-2 text-sm font-semibold text-reloop-muted transition-colors hover:text-reloop-ink">Sign in</Link>
          <Link href="/register" className="brand-button brand-button-primary min-h-[44px] px-5">Create workspace <ArrowUpRight /></Link>
        </div>

        <button
          type="button"
          className="relative grid h-11 w-11 place-items-center border border-reloop-line bg-reloop-surface text-reloop-ink lg:hidden"
          aria-label={mobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={mobileOpen}
          aria-controls="marketing-mobile-menu"
          onClick={() => setMobileOpen((open) => !open)}
        >
          <span className="sr-only">{mobileOpen ? 'Close menu' : 'Open menu'}</span>
          <span className={`absolute h-px w-5 bg-current transition-transform duration-300 ${mobileOpen ? 'rotate-45' : '-translate-y-1.5'}`} />
          <span className={`absolute h-px w-5 bg-current transition-opacity duration-200 ${mobileOpen ? 'opacity-0' : 'opacity-100'}`} />
          <span className={`absolute h-px w-5 bg-current transition-transform duration-300 ${mobileOpen ? '-rotate-45' : 'translate-y-1.5'}`} />
        </button>
      </div>

    </header>

      <div id="marketing-mobile-menu" aria-hidden={!mobileOpen} className={`fixed inset-x-0 bottom-0 top-[66px] z-40 transition-[visibility] duration-300 lg:hidden ${mobileOpen ? 'visible' : 'invisible delay-300'}`}>
        <button type="button" aria-label="Close navigation menu" onClick={closeMobileMenu} style={{ right: 'min(88vw, 390px)' }} className={`absolute inset-y-0 left-0 bg-reloop-ink/35 backdrop-blur-sm transition-opacity duration-300 ${mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`} />
        <nav aria-label="Mobile navigation" className={`relative ml-auto flex h-full w-[min(88vw,390px)] flex-col border-l border-reloop-line bg-reloop-paper px-5 py-7 shadow-elevated transition-transform duration-300 ease-brand ${mobileOpen ? 'translate-x-0' : 'translate-x-full'}`}>
          <p className="brand-data border-b border-reloop-line pb-4 text-[11px] font-semibold tracking-[0.08em] text-reloop-faint">EXPLORE RELOOP</p>
          <div className="mt-3 divide-y divide-reloop-line">
            {[
              ['Product', '#product'],
              ['How it works', '#how-it-works'],
              ['Integrations', '#integrations'],
              ['Pricing', '#pricing'],
            ].map(([label, href]) => (
              <Link key={href} href={href} onClick={closeMobileMenu} tabIndex={mobileOpen ? 0 : -1} className="flex min-h-14 items-center justify-between text-base font-semibold text-reloop-ink">
                {label}<span aria-hidden="true" className="text-reloop-signal">↘</span>
              </Link>
            ))}
          </div>
          <div className="mt-auto grid gap-3 border-t border-reloop-line pt-6">
            <Link href="/login" onClick={closeMobileMenu} tabIndex={mobileOpen ? 0 : -1} className="brand-button brand-button-secondary !min-h-12">Sign in</Link>
            <Link href="/register" onClick={closeMobileMenu} tabIndex={mobileOpen ? 0 : -1} className="brand-button brand-button-primary !min-h-12">Create workspace <ArrowUpRight /></Link>
          </div>
        </nav>
      </div>
    </>
  );
}
