import Image from 'next/image';
import type { CSSProperties } from 'react';
import { SectionIndex } from '../brand/SectionIndex';

const systemStates = [
  {
    system: 'Shopify',
    channel: 'COMMERCE',
    time: '10:14:02',
    label: 'Fulfillment state',
    value: 'Unfulfilled',
    color: '#527320',
    soft: '#eef5df',
  },
  {
    system: 'ShipStation',
    channel: 'SHIPPING',
    time: '10:42:18',
    label: 'Shipment state',
    value: 'In transit',
    color: '#245f80',
    soft: '#e8f2f8',
  },
  {
    system: 'Storefront',
    channel: 'CUSTOMER VIEW',
    time: '10:43:06',
    label: 'Order message',
    value: 'Processing',
    color: '#6e547b',
    soft: '#f0eaf3',
  },
];

function HealthDot() {
  return <span className="inline-block h-1.5 w-1.5 rounded-full bg-reloop-verified shadow-[0_0_0_4px_rgba(8,120,91,0.1)]" />;
}

export function OperationalGap() {
  return (
    <section id="operational-gap" className="border-t border-reloop-line bg-reloop-paper">
      <div className="mx-auto max-w-[1440px] border-x border-reloop-line px-5 py-20 sm:px-10 lg:px-12 lg:py-28">
        <div data-reveal="up">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-16">
            <div>
            <SectionIndex number="02" label="SYSTEM TRUTH" note="THREE HEALTHY SYSTEMS / ONE INVALID OUTCOME" />
            <h2 className="brand-display brand-section-title mt-6 max-w-5xl">
              Every system can be healthy. The order can still be wrong.
            </h2>
            <div className="mt-9 grid gap-5 border-t border-reloop-line pt-6 xl:grid-cols-[0.62fr_1.38fr]">
              <div className="flex items-start gap-3 brand-data text-[10px] font-semibold tracking-[0.13em] text-reloop-muted">
                <span className="mt-1 h-2 w-2 shrink-0 bg-reloop-signal" />
                <span>UPTIME ≠ OPERATIONAL TRUTH</span>
              </div>
              <p className="max-w-2xl text-base leading-7 text-reloop-muted">
                Traditional monitoring tells you whether each provider is online. It cannot tell you whether those providers agree about the customer&apos;s order.
              </p>
            </div>
            </div>
            <aside className="grid grid-cols-3 border-y border-reloop-line lg:mt-9 lg:block lg:border-y-0 lg:border-l lg:pl-8" aria-label="Incident summary">
              {[
                ['03', 'providers reporting'],
                ['01', 'order conflict'],
                ['00', 'systems offline'],
              ].map(([value, label]) => (
                <div key={label} className="border-r border-reloop-line px-3 py-5 last:border-r-0 lg:border-b lg:border-r-0 lg:px-0 lg:py-6 lg:first:pt-0">
                  <p className="font-display text-3xl font-semibold tracking-[-0.045em]">{value}</p>
                  <p className="mt-2 brand-data text-[9px] uppercase leading-4 tracking-[0.11em] text-reloop-faint">{label}</p>
                </div>
              ))}
            </aside>
          </div>
        </div>

        <div data-reveal="scale" className="mt-14 overflow-hidden border-y border-reloop-line bg-reloop-surface lg:mt-16">
          <div className="flex flex-col gap-4 border-b border-reloop-line bg-[#f0ece3] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
            <div className="flex items-center gap-4">
              <span className="brand-data text-[9px] font-semibold tracking-[0.14em] text-reloop-ink">ORDER / RL-2048</span>
              <span className="h-3 w-px bg-reloop-line-strong" />
              <span className="brand-data text-[9px] tracking-[0.12em] text-reloop-faint">OBSERVED 10:43 UTC</span>
            </div>
            <div className="flex items-center gap-2 brand-data text-[9px] font-semibold tracking-[0.12em] text-reloop-verified"><HealthDot /> 3 / 3 SYSTEMS HEALTHY</div>
          </div>

          <div className="grid lg:grid-cols-[1fr_0.82fr]">
            <div className="relative border-b border-reloop-line p-5 sm:p-8 lg:border-b-0 lg:border-r lg:p-10">
              <div className="mb-6 flex items-center justify-between">
                <p className="brand-data text-[9px] font-semibold tracking-[0.16em] text-reloop-faint">INDIVIDUAL SYSTEM REPORTS</p>
                <span className="brand-data text-[8px] tracking-[0.12em] text-reloop-verified">NO INCIDENTS</span>
              </div>

              <div className="relative space-y-3">
                <div className="absolute bottom-8 left-[27px] top-8 w-px bg-reloop-line" aria-hidden="true" />
                {systemStates.map((item, index) => (
                  <article key={item.system} className="group relative z-10 grid gap-5 border-t border-reloop-line bg-reloop-surface p-4 first:border-t-0 sm:grid-cols-[1fr_auto] sm:items-center sm:p-5">
                    <div className="flex items-center gap-4">
                      <div className="grid h-12 w-12 shrink-0 place-items-center border text-sm font-bold" style={{ color: item.color, backgroundColor: item.soft, borderColor: `${item.color}30` }}>{item.system.charAt(0)}</div>
                      <div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <h3 className="text-sm font-semibold tracking-[-0.02em]">{item.system}</h3>
                          <span className="brand-data text-[8px] tracking-[0.12em] text-reloop-faint">{item.channel}</span>
                        </div>
                        <div className="mt-2 flex items-center gap-2 text-xs text-reloop-verified"><HealthDot /> Provider healthy</div>
                      </div>
                    </div>
                    <div className="border-t border-reloop-line pt-4 sm:min-w-[190px] sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
                      <div className="flex items-center justify-between gap-5"><span className="brand-data text-[8px] tracking-[0.12em] text-reloop-faint">{item.label.toUpperCase()}</span><span className="brand-data text-[8px] text-reloop-faint">{item.time}</span></div>
                      <p className="mt-2 text-base font-semibold tracking-[-0.025em]">{item.value}</p>
                    </div>
                    <span className="absolute -left-px top-1/2 h-8 w-[3px] -translate-y-1/2 rounded-r bg-reloop-signal opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                    <span className="sr-only">System report {index + 1} of {systemStates.length}</span>
                  </article>
                ))}
              </div>
            </div>

            <div className="relative flex min-h-[560px] flex-col justify-between overflow-hidden bg-reloop-ink p-6 text-reloop-paper sm:p-9 lg:p-10">
              <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-25" viewBox="0 0 520 560" fill="none" aria-hidden="true">
                <path d="M-20 116H154C225 116 212 280 286 280H540" stroke="#777970" strokeWidth="1" />
                <path d="M-20 280H540" stroke="#777970" strokeWidth="1" strokeDasharray="5 9" />
                <path d="M-20 444H154C225 444 212 280 286 280" stroke="#777970" strokeWidth="1" />
                <circle cx="286" cy="280" r="7" fill="#FF5C35" />
                <circle cx="286" cy="280" r="18" stroke="#FF5C35" strokeOpacity="0.35" />
              </svg>

              <div className="relative flex items-center justify-between">
                <p className="brand-data text-[9px] font-semibold tracking-[0.16em] text-[#8f9189]">CROSS-SYSTEM REALITY</p>
                <span className="rounded-full border border-reloop-signal/40 bg-reloop-signal/10 px-3 py-1.5 brand-data text-[8px] font-semibold tracking-[0.12em] text-[#ff8d70]">CONFLICT</span>
              </div>

              <div className="relative py-16 sm:py-20">
                <Image src="/brand/reloop-symbol-light.svg" alt="" width={56} height={56} />
                <p className="mt-8 brand-data text-[9px] font-semibold tracking-[0.16em] text-[#ff8060]">NO SYSTEM IS DOWN</p>
                <h3 className="mt-4 max-w-md text-4xl font-semibold leading-[1.02] tracking-[-0.055em] sm:text-5xl">The shared truth drifted.</h3>
                <p className="mt-6 max-w-md text-sm leading-7 text-[#aaaca5]">Three valid provider responses produce one invalid operational picture. No individual status page can see the contradiction.</p>
              </div>

              <div className="relative grid grid-cols-2 gap-px overflow-hidden border-y border-white/10 bg-white/10">
                <div className="bg-reloop-ink p-4"><p className="brand-data text-[8px] tracking-[0.12em] text-[#777970]">SYSTEM HEALTH</p><p className="mt-2 text-sm font-semibold text-[#7ed8ba]">All operational</p></div>
                <div className="bg-reloop-ink p-4"><p className="brand-data text-[8px] tracking-[0.12em] text-[#777970]">ORDER TRUTH</p><p className="mt-2 text-sm font-semibold text-[#ff8d70]">Unresolved</p></div>
              </div>
            </div>
          </div>
        </div>

        <div data-reveal="soft" data-reveal-group className="mt-12 grid gap-px overflow-hidden border-y border-reloop-line bg-reloop-line md:grid-cols-3">
          {[
            ['MONITORING ASKS', 'Are the systems reachable?'],
            ['OPERATIONS ASKS', 'Which state should we trust?'],
            ['RELOOP ANSWERS', 'What is the safe next step?'],
          ].map(([label, value], index) => (
            <div key={label} className="bg-reloop-paper px-5 py-7 sm:px-7" style={{ '--reveal-order': index } as CSSProperties}>
              <p className="brand-data text-[8px] font-semibold tracking-[0.16em] text-reloop-faint">{label}</p>
              <p className="mt-3 text-lg font-semibold tracking-[-0.025em]">{value}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
