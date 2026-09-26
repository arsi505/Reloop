import Image from 'next/image';
import { RecoveryWorkflow } from './RecoveryWorkflow';

const trustPoints = [
  ['Human approval', 'Sensitive actions can require authorization.'],
  ['Scoped recovery', 'Each recovery is limited to the affected case.'],
  ['Verified outcome', 'Reloop checks provider state again before marking the case resolved.'],
];

function WarehouseMark() {
  return (
    <svg width="42" height="42" viewBox="0 0 56 56" fill="none" aria-hidden="true">
      <path d="M9 23L28 11L47 23V46H9V23Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M18 46V28H38V46M18 34H38M24 28V46M32 28V46" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="46" cy="13" r="5" fill="#FF5C35" />
    </svg>
  );
}

export function SafetyIntegrations() {
  return (
    <>
      <section id="how-it-works" className="border-y border-reloop-line bg-reloop-paper">
        <div className="mx-auto max-w-[1280px] px-5 py-14 sm:px-8 sm:py-16 lg:px-12">
          <div data-reveal="up" className="max-w-4xl">
            <p className="text-sm font-semibold text-reloop-signal-hover">How recovery works</p>
            <h2 className="brand-display mt-5 text-[clamp(2.65rem,4.1vw,4rem)] leading-[0.95] tracking-[-0.055em]">A clear path from mismatch to verified outcome.</h2>
          </div>

          <RecoveryWorkflow />

          <div className="mt-8 grid overflow-hidden rounded-xl border border-reloop-line bg-reloop-canvas sm:grid-cols-3">
            {trustPoints.map(([title, description], index) => (
              <div key={title} className={`p-5 sm:p-6 ${index < trustPoints.length - 1 ? 'border-b border-reloop-line sm:border-b-0 sm:border-r' : ''}`}>
                <h3 className="text-base font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-reloop-muted">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="integrations" className="bg-reloop-canvas">
        <div className="mx-auto max-w-[1280px] px-5 py-14 sm:px-8 sm:py-16 lg:px-12">
          <div data-reveal="up" className="grid gap-8 lg:grid-cols-[1fr_0.72fr] lg:items-end lg:gap-16">
            <div>
              <p className="text-sm font-semibold text-reloop-signal-hover">Integrations</p>
              <h2 className="brand-display mt-5 max-w-4xl text-[clamp(2.65rem,4.1vw,4rem)] leading-[0.95] tracking-[-0.055em]">Built around the systems in your fulfillment workflow.</h2>
            </div>
            <p className="max-w-xl text-lg leading-8 text-reloop-muted">Reloop brings order, shipment, and warehouse state together so your team can spot and resolve mismatches from one place.</p>
          </div>

          <div data-reveal="soft" className="mt-8 grid gap-4 lg:grid-cols-[1fr_160px_0.82fr] lg:items-center">
            <div className="space-y-3">
              <a href="https://www.shopify.com" target="_blank" rel="noreferrer" className="group flex min-h-[96px] items-center justify-between gap-5 rounded-xl border border-reloop-line bg-white p-5 transition-transform duration-300 hover:-translate-y-0.5" aria-label="Shopify (opens in a new tab)">
                <Image src="/integrations/shopify-logo.svg" alt="Shopify" width={140} height={40} className="h-auto w-[122px]" />
                <div className="text-right text-sm"><p className="text-reloop-muted">Orders</p><p className="mt-1 font-semibold text-reloop-verified">Connected</p></div>
              </a>
              <a href="https://www.shipstation.com" target="_blank" rel="noreferrer" className="group flex min-h-[96px] items-center justify-between gap-5 rounded-xl border border-reloop-line bg-white p-5 transition-transform duration-300 hover:-translate-y-0.5" aria-label="ShipStation (opens in a new tab)">
                <Image src="/integrations/shipstation-logo.svg" alt="ShipStation" width={170} height={27} style={{ width: '154px', height: 'auto' }} />
                <div className="text-right text-sm"><p className="text-reloop-muted">Shipping</p><p className="mt-1 font-semibold text-reloop-verified">Connected</p></div>
              </a>
              <div className="flex min-h-[96px] items-center justify-between gap-5 rounded-xl border border-reloop-line bg-white p-5">
                <div className="flex items-center gap-4"><WarehouseMark /><div><p className="text-base font-semibold">Warehouse / 3PL</p><p className="mt-1 text-sm text-reloop-muted">Warehouse status</p></div></div>
                <div className="text-right text-sm"><p className="text-reloop-muted">Status</p><p className="mt-1 font-semibold">Connected</p></div>
              </div>
            </div>

            <div className="relative hidden h-[276px] lg:block" aria-hidden="true">
              {[18, 50, 82].map((position, index) => (
                <span key={position} className="absolute left-0 right-0 h-px bg-reloop-line" style={{ top: `${position}%` }}>
                  <span className="integration-signal absolute -top-[3px] left-0 h-[7px] w-[7px] rounded-full bg-reloop-signal" style={{ animationDelay: `${index * 1.15}s` }} />
                </span>
              ))}
              <span className="absolute bottom-[18%] right-0 top-[18%] w-px bg-reloop-line" />
            </div>

            <div className="relative overflow-hidden rounded-xl bg-reloop-ink p-6 text-reloop-paper shadow-[0_24px_70px_rgba(23,24,20,0.16)] sm:p-7">
              <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full border border-white/10" aria-hidden="true" />
              <Image src="/brand/reloop-symbol.svg" alt="" width={42} height={42} className="brightness-0 invert" />
              <p className="mt-6 text-xs font-semibold uppercase tracking-[0.16em] text-[#b8bab2]">Reloop operations</p>
              <h3 className="mt-3 text-3xl font-semibold tracking-[-0.045em]">Provider states in one case.</h3>
              <p className="mt-3 text-sm leading-6 text-[#b8bab2]">Evidence arrives together, recovery stays scoped, and the outcome is checked before resolution.</p>
              <div className="mt-6 flex items-center justify-between border-t border-white/15 pt-4 text-sm"><span className="text-[#b8bab2]">Case RL-2048</span><span className="font-semibold text-[#8dd8bc]">Systems aligned</span></div>
            </div>
          </div>

        </div>
      </section>
    </>
  );
}
