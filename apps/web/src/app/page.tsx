import Link from 'next/link';
import { ClosingCTA } from '../components/marketing/ClosingCTA';
import { MarketingHeader } from '../components/marketing/MarketingHeader';
import { MotionSystem } from '../components/marketing/MotionSystem';
import { OperationalGap } from '../components/marketing/OperationalGap';
import { PricingFaq } from '../components/marketing/PricingFaq';
import { RecoveryCircuit } from '../components/marketing/RecoveryCircuit';
import { SafetyIntegrations } from '../components/marketing/SafetyIntegrations';

function ArrowUpRight() {
  return (
    <svg className="brand-button-icon" width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M4 11L11 4M5 4H11V10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Home() {
  return (
    <>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <main id="main-content" className="min-h-screen overflow-x-clip bg-reloop-canvas text-reloop-ink">
        <MotionSystem />
        <MarketingHeader />

        <section className="mx-auto grid max-w-[1440px] px-5 pb-14 pt-12 sm:px-8 sm:pb-16 sm:pt-16 lg:grid-cols-[0.95fr_1.05fr] lg:items-center lg:gap-12 lg:px-12 lg:py-16 xl:gap-16">
          <div data-reveal="soft" data-reveal-group className="max-w-[680px]">
            <p className="text-sm font-semibold text-reloop-signal-hover">Commerce reliability</p>
            <h1 className="brand-display mt-5 max-w-[680px] text-[clamp(3.25rem,5vw,4.75rem)] leading-[0.92] tracking-[-0.06em]">
              Keep Shopify, ShipStation, and your warehouse in sync.
            </h1>
            <p className="mt-7 max-w-[590px] text-lg leading-8 text-reloop-muted">
              Reloop detects when order, shipment, and warehouse status disagree, brings the relevant details into one case, and helps your team recover safely.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/register" className="brand-button brand-button-primary min-h-[50px] px-6">Create workspace <ArrowUpRight /></Link>
              <Link href="#product" className="brand-button brand-button-secondary min-h-[50px] px-6">See the product</Link>
            </div>
          </div>

          <div data-reveal="scale" className="mt-12 min-w-0 lg:mt-0">
            <RecoveryCircuit />
          </div>
        </section>

        <OperationalGap />
        <SafetyIntegrations />
        <PricingFaq />
        <ClosingCTA />
      </main>
    </>
  );
}
