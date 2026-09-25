import Link from 'next/link';
import type { CSSProperties } from 'react';
import { BrandLockup } from '../components/brand/BrandLockup';
import { SectionIndex } from '../components/brand/SectionIndex';
import { ClosingCTA } from '../components/marketing/ClosingCTA';
import { IncidentJourney } from '../components/marketing/IncidentJourney';
import { MotionSystem } from '../components/marketing/MotionSystem';
import { OperationalGap } from '../components/marketing/OperationalGap';
import { RecoveryCircuit } from '../components/marketing/RecoveryCircuit';
import { SafetyIntegrations } from '../components/marketing/SafetyIntegrations';

function ArrowUpRight() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M4 11L11 4M5 4H11V10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Home() {
  return (
    <>
    <a href="#main-content" className="skip-link">Skip to main content</a>
    <main id="main-content" className="brand-noise min-h-screen overflow-x-clip bg-reloop-canvas text-reloop-ink">
      <MotionSystem />
      <header className="sticky top-0 z-50 border-b border-reloop-line bg-reloop-canvas/90 backdrop-blur-xl">
        <div className="mx-auto flex h-[76px] max-w-[1440px] items-center justify-between px-5 sm:px-8 lg:px-12">
          <Link href="/" aria-label="Reloop homepage" className="shrink-0">
            <BrandLockup size="default" priority className="scale-[0.88] origin-left sm:scale-100" />
          </Link>

          <nav aria-label="Primary navigation" className="hidden items-center gap-8 lg:flex">
            <Link href="/dashboard" className="brand-link-line text-[13px] font-semibold text-reloop-muted transition-colors hover:text-reloop-ink">Product</Link>
            <Link href="#operational-gap" className="brand-link-line text-[13px] font-semibold text-reloop-muted transition-colors hover:text-reloop-ink">Why Reloop</Link>
            <Link href="#incident-journey" className="brand-link-line text-[13px] font-semibold text-reloop-muted transition-colors hover:text-reloop-ink">Incident journey</Link>
            <Link href="#safety" className="brand-link-line text-[13px] font-semibold text-reloop-muted transition-colors hover:text-reloop-ink">Safety</Link>
          </nav>

          <div className="flex items-center gap-2 sm:gap-3">
            <Link href="/login" className="hidden px-3 py-2 text-[13px] font-semibold text-reloop-muted transition-colors hover:text-reloop-ink sm:block">Sign in</Link>
            <Link href="/register" className="brand-button brand-button-primary min-h-[40px] px-3.5 sm:px-5">Create workspace <span className="hidden sm:inline"><ArrowUpRight /></span></Link>
          </div>
        </div>
      </header>

      <section className="mx-auto grid max-w-[1440px] border-x border-reloop-line lg:min-h-[calc(100vh-76px)] lg:grid-cols-[0.93fr_1.07fr]">
        <div className="relative flex flex-col justify-between border-b border-reloop-line px-5 py-14 sm:px-10 sm:py-20 lg:border-b-0 lg:border-r lg:px-12 lg:py-16 xl:py-20">
          <div data-reveal="up">
            <SectionIndex number="01" label="RECONCILIATION ENGINE" note="COMMERCE OPERATIONS" />

            <h1 className="brand-display brand-hero-title mt-8 max-w-[760px]">
              When systems disagree, operations need one truth.
            </h1>

            <p className="mt-8 max-w-[620px] text-[17px] leading-8 text-reloop-muted sm:text-lg">
              Reloop detects conflicting order states, coordinates a safe recovery, and preserves the evidence—without asking your team to reconstruct the incident across five tabs.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link href="/register" className="brand-button brand-button-primary min-h-[50px] px-6">Start with a workspace <ArrowUpRight /></Link>
              <Link href="#system-logic" className="brand-button brand-button-secondary min-h-[50px] px-6">See the system logic ↓</Link>
            </div>
          </div>

          <div data-reveal="soft" data-reveal-group className="mt-16 grid gap-4 border-t border-reloop-line pt-6 sm:grid-cols-3 lg:mt-12 xl:mt-20">
            {[
              ['01', 'Tenant isolated'],
              ['02', 'Approval guarded'],
              ['03', 'Evidence preserved'],
            ].map(([number, label]) => (
              <div key={number} className="flex items-center gap-3 sm:block" style={{ '--reveal-order': Number(number) - 1 } as CSSProperties}>
                <span className="brand-data text-[9px] text-reloop-signal-hover">{number}</span>
                <p className="brand-data text-[9px] font-semibold tracking-[0.1em] text-reloop-muted sm:mt-2">{label.toUpperCase()}</p>
              </div>
            ))}
          </div>
        </div>

        <div data-reveal="scale" className="brand-grid relative min-h-[780px] overflow-hidden bg-reloop-paper px-5 py-12 sm:px-10 sm:py-16 lg:min-h-0 lg:px-12">
          <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-reloop-paper to-transparent" />
          <RecoveryCircuit />
        </div>
      </section>

      <section id="system-logic" className="border-t border-reloop-line bg-reloop-ink text-reloop-paper">
        <div className="mx-auto grid max-w-[1440px] gap-px bg-white/10 lg:grid-cols-4">
          {[
            ['01', 'Check', 'Compare normalized state across connected providers.'],
            ['02', 'Decide', 'Apply policy and identify where judgment is required.'],
            ['03', 'Recover', 'Coordinate the safest available corrective action.'],
            ['04', 'Verify', 'Re-check the source systems before closing the loop.'],
          ].map(([number, title, copy]) => (
            <article key={number} data-reveal="soft" data-lift className="bg-reloop-ink px-6 py-10 sm:px-10 lg:min-h-[230px] lg:px-8">
              <div className="flex items-center justify-between"><span className="brand-data text-[9px] text-[#73756e]">{number}</span><span className="h-1.5 w-1.5 rounded-full bg-reloop-signal" /></div>
              <h2 className="mt-12 text-2xl font-semibold tracking-[-0.04em]">{title}</h2>
              <p className="mt-3 text-sm leading-6 text-[#a9aba4]">{copy}</p>
            </article>
          ))}
        </div>
      </section>

      <OperationalGap />
      <IncidentJourney />
      <SafetyIntegrations />
      <ClosingCTA />
    </main>
    </>
  );
}
