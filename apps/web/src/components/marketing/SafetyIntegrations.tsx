import Image from 'next/image';
import Link from 'next/link';
import { SectionIndex } from '../brand/SectionIndex';

const boundaries = [
  {
    number: '01',
    label: 'Tenant boundary',
    detail: 'Organization-scoped data, credentials, and operational records.',
    status: 'ISOLATED',
  },
  {
    number: '02',
    label: 'Policy evaluation',
    detail: 'Every proposed recovery is checked before execution.',
    status: 'PASSED',
  },
  {
    number: '03',
    label: 'Human authority',
    detail: 'Sensitive mutations stop for an explicitly authorized operator.',
    status: 'REQUIRED',
  },
  {
    number: '04',
    label: 'Scoped execution',
    detail: 'The approved action is bounded to the case and intended resource.',
    status: '1 ORDER',
  },
  {
    number: '05',
    label: 'Verified evidence',
    detail: 'Provider state is read again and the full sequence is preserved.',
    status: 'RECORDED',
  },
];

function ArrowUpRight() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.5 10.5L10.5 3.5M5 3.5H10.5V9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function WarehouseMark() {
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true">
      <path d="M9 23L28 11L47 23V46H9V23Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M18 46V28H38V46M18 34H38M24 28V46M32 28V46" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="46" cy="13" r="5" fill="#FF5C35" />
    </svg>
  );
}

export function SafetyIntegrations() {
  return (
    <>
      <section id="safety" className="border-t border-reloop-line bg-reloop-canvas">
        <div className="mx-auto max-w-[1440px] border-x border-reloop-line px-5 py-20 sm:px-10 lg:px-12 lg:py-28">
          <div data-reveal="up" className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_350px] lg:items-start lg:gap-20">
            <div>
              <SectionIndex number="04" label="CONTROL PLANE" note="SAFETY IS THE PRODUCT" />
              <h2 className="brand-display brand-section-title mt-6 max-w-5xl">Automation with visible boundaries.</h2>
            </div>
            <div className="relative border-t border-reloop-line pt-5 lg:mt-9">
              <div className="flex items-end justify-between border-b border-reloop-line pb-5"><span className="brand-data text-[9px] font-semibold tracking-[0.14em] text-reloop-faint">CONTROL MODEL</span><span className="font-display text-6xl font-semibold leading-none tracking-[-0.06em] text-reloop-signal">05</span></div>
              <p className="pt-5 text-base leading-7 text-reloop-muted">No control is hidden behind an “AI-powered” label. Each boundary is explicit, inspectable, and attached to the incident record.</p>
            </div>
          </div>

          <div data-reveal="scale" className="mt-16 grid overflow-hidden border-y border-reloop-line bg-reloop-line lg:mt-20 lg:grid-cols-[0.86fr_1.14fr] lg:gap-px">
            <div className="relative overflow-hidden bg-reloop-ink p-6 text-reloop-paper sm:p-9 lg:p-10">
              <div className="absolute inset-0 opacity-[0.08] brand-grid" />
              <div className="relative flex items-center justify-between"><span className="brand-data text-[9px] font-semibold tracking-[0.16em] text-[#898b83]">RECOVERY ENVELOPE</span><span className="flex items-center gap-2 brand-data text-[8px] tracking-[0.12em] text-[#75d5b6]"><span className="h-1.5 w-1.5 rounded-full bg-reloop-verified" />ENFORCED</span></div>

              <div className="relative mx-auto my-14 grid aspect-square max-w-[420px] place-items-center rounded-full border border-white/10 sm:my-20">
                <div className="motion-orbit-slow absolute inset-[11%] rounded-full border border-dashed border-white/15" />
                <div className="motion-orbit-reverse absolute inset-[24%] rounded-full border border-white/10" />
                <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/15 bg-reloop-ink px-3 py-2 brand-data text-[8px] tracking-[0.12em] text-[#92948c]">TENANT</div>
                <div className="absolute bottom-[9%] left-[8%] rounded-full border border-white/15 bg-reloop-ink px-3 py-2 brand-data text-[8px] tracking-[0.12em] text-[#92948c]">POLICY</div>
                <div className="absolute bottom-[9%] right-[8%] rounded-full border border-white/15 bg-reloop-ink px-3 py-2 brand-data text-[8px] tracking-[0.12em] text-[#92948c]">EVIDENCE</div>
                <div className="motion-breathe relative grid h-[38%] w-[38%] place-items-center rounded-full border border-reloop-signal/35 bg-[#1c1b16] shadow-[0_0_60px_rgba(255,92,53,0.13)]"><Image src="/brand/reloop-symbol-light.svg" alt="Reloop protected recovery" width={98} height={98} className="w-[58%]" /></div>
                <span className="absolute left-1/2 top-[11%] h-[13%] w-px -translate-x-1/2 bg-gradient-to-b from-white/30 to-transparent" />
                <span className="absolute bottom-[19%] left-[23%] h-px w-[18%] rotate-[35deg] bg-gradient-to-r from-white/30 to-transparent" />
                <span className="absolute bottom-[19%] right-[23%] h-px w-[18%] -rotate-[35deg] bg-gradient-to-l from-white/30 to-transparent" />
              </div>

              <div className="relative grid grid-cols-2 gap-px overflow-hidden border-y border-white/10 bg-white/10">
                <div className="bg-reloop-ink p-4"><p className="brand-data text-[8px] tracking-[0.12em] text-[#70726a]">EXECUTION SCOPE</p><p className="mt-2 text-sm font-semibold">Case bounded</p></div>
                <div className="bg-reloop-ink p-4"><p className="brand-data text-[8px] tracking-[0.12em] text-[#70726a]">CLOSURE RULE</p><p className="mt-2 text-sm font-semibold">Verify first</p></div>
              </div>
            </div>

            <div className="bg-reloop-surface p-5 sm:p-8 lg:p-10">
              <div className="flex items-center justify-between border-b border-reloop-line pb-5"><span className="brand-data text-[9px] font-semibold tracking-[0.16em] text-reloop-faint">CONTROL SEQUENCE</span><span className="brand-data text-[8px] text-reloop-verified">5 / 5 ACTIVE</span></div>
              <div>
                {boundaries.map((item, index) => (
                  <div key={item.number} className="group grid gap-4 border-b border-reloop-line py-6 transition-transform duration-300 hover:translate-x-1 last:border-b-0 sm:grid-cols-[44px_1fr_auto] sm:items-center">
                    <div className="relative grid h-9 w-9 place-items-center rounded-full border border-reloop-line bg-reloop-paper brand-data text-[8px] text-reloop-faint"><span>{item.number}</span>{index < boundaries.length - 1 && <span className="absolute left-1/2 top-full hidden h-[38px] w-px -translate-x-1/2 bg-reloop-line sm:block" />}</div>
                    <div><h3 className="text-base font-semibold tracking-[-0.025em]">{item.label}</h3><p className="mt-1 max-w-lg text-sm leading-6 text-reloop-muted">{item.detail}</p></div>
                    <span className="w-fit rounded-full border border-reloop-verified/20 bg-reloop-verified-soft px-3 py-1.5 brand-data text-[8px] font-semibold tracking-[0.1em] text-reloop-verified">{item.status}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="integrations" className="border-t border-reloop-line bg-reloop-paper">
        <div className="mx-auto max-w-[1440px] border-x border-reloop-line px-5 py-20 sm:px-10 lg:px-12 lg:py-28">
          <div data-reveal="up">
            <div>
              <SectionIndex number="05" label="PROVIDER GRAPH" note="CONTEXT PRESERVED" />
              <div className="mt-4 flex items-center justify-end gap-3 brand-data text-[9px] tracking-[0.12em] text-reloop-faint"><span>SOURCE SYSTEMS</span><span className="text-reloop-signal">→</span><span>RELOOP</span><span className="text-reloop-signal">→</span><span>OPERATIONS</span></div>
            </div>
            <div className="mt-10 grid gap-10 lg:grid-cols-[1.25fr_0.75fr] lg:items-end lg:gap-20">
              <h2 className="brand-display brand-section-title max-w-4xl">One layer across the stack.</h2>
              <div><p className="text-lg leading-8 text-reloop-muted">Reloop normalizes operational state while preserving the provider context your team needs to understand what actually happened.</p><Link href="/integrations" className="mt-7 inline-flex items-center gap-2 text-sm font-semibold text-reloop-ink underline decoration-reloop-signal decoration-2 underline-offset-8">Explore integrations <ArrowUpRight /></Link></div>
            </div>
          </div>

          <div data-reveal="scale" className="brand-grid relative mt-16 overflow-hidden border-y border-reloop-line bg-reloop-canvas p-5 pt-20 sm:min-h-[720px] sm:p-10 lg:mt-20 lg:p-14">
            <div className="absolute inset-x-0 top-0 flex items-center justify-between border-b border-reloop-line bg-reloop-paper/75 px-5 py-4 backdrop-blur-sm sm:px-8"><span className="brand-data text-[8px] font-semibold tracking-[0.15em] text-reloop-faint">INTEGRATION TOPOLOGY</span><span className="flex items-center gap-2 brand-data text-[8px] tracking-[0.12em] text-reloop-verified"><span className="h-1.5 w-1.5 rounded-full bg-reloop-verified" />SIGNALS CONNECTED</span></div>

            <div className="relative sm:hidden">
              <div className="absolute bottom-10 left-1/2 top-10 w-px -translate-x-1/2 bg-reloop-line" aria-hidden="true" />
              <div className="relative space-y-5">
                <div className="border border-reloop-line bg-reloop-surface p-5"><Image src="/integrations/shopify-logo.svg" alt="Shopify" width={136} height={39} className="h-auto w-[124px]" /><div className="mt-5 flex items-center justify-between border-t border-reloop-line pt-4"><span className="brand-data text-[8px] tracking-[0.1em] text-reloop-faint">COMMERCE STATE</span><span className="text-xs font-semibold text-reloop-verified">Connected</span></div></div>
                <div className="relative z-10 mx-auto grid h-36 w-36 place-items-center rounded-full border border-reloop-ink bg-reloop-ink shadow-elevated"><div className="text-center"><Image src="/brand/reloop-symbol-light.svg" alt="Reloop" width={68} height={68} className="mx-auto" /><p className="mt-2 brand-data text-[7px] font-semibold tracking-[0.15em] text-[#999b93]">RECONCILE</p></div></div>
                <div className="border border-reloop-line bg-reloop-surface p-5"><Image src="/integrations/shipstation-logo.svg" alt="ShipStation" width={168} height={26} style={{ width: '150px', height: 'auto' }} /><div className="mt-5 flex items-center justify-between border-t border-reloop-line pt-4"><span className="brand-data text-[8px] tracking-[0.1em] text-reloop-faint">SHIPMENT STATE</span><span className="text-xs font-semibold text-reloop-verified">Connected</span></div></div>
                <div className="border border-reloop-line bg-reloop-surface p-5"><div className="flex items-center gap-4 text-reloop-ink"><WarehouseMark /><div><p className="text-xl font-semibold tracking-[-0.035em]">Your 3PL</p><p className="mt-1 brand-data text-[8px] tracking-[0.12em] text-reloop-faint">CUSTOM PROVIDER</p></div></div><div className="mt-5 flex items-center justify-between border-t border-reloop-line pt-4"><span className="brand-data text-[8px] tracking-[0.1em] text-reloop-faint">WAREHOUSE STATE</span><span className="text-xs font-semibold text-reloop-muted">API ready</span></div></div>
                <div className="relative mx-auto w-fit rounded-full border border-reloop-line bg-reloop-paper px-3 py-2 text-center brand-data text-[7px] tracking-[0.1em] text-reloop-muted">PROVIDER CONTEXT PRESERVED</div>
              </div>
            </div>

            <div className="relative mx-auto hidden min-h-[620px] max-w-[1000px] items-center justify-center pt-14 sm:flex">
              <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1000 620" fill="none" aria-hidden="true">
                <path d="M190 165C330 165 330 310 440 310" stroke="#AAA69D" strokeWidth="1.5" />
                <path d="M190 455C330 455 330 310 440 310" stroke="#AAA69D" strokeWidth="1.5" />
                <path d="M560 310H790" stroke="#AAA69D" strokeWidth="1.5" />
                <path d="M250 310H440" stroke="#D8D2C7" strokeWidth="1" strokeDasharray="5 8" />
                <circle cx="440" cy="310" r="4" fill="#FF5C35" />
                <circle cx="560" cy="310" r="4" fill="#08785B" />
              </svg>

              <div className="absolute left-0 top-[19%] w-[42%] max-w-[300px] border border-reloop-line bg-reloop-surface p-5 sm:p-6">
                <a href="https://www.shopify.com" target="_blank" rel="noreferrer" className="block" aria-label="Shopify (opens in a new tab)"><Image src="/integrations/shopify-logo.svg" alt="Shopify" width={150} height={43} className="h-auto w-[128px] sm:w-[150px]" /></a>
                <div className="mt-6 flex items-center justify-between border-t border-reloop-line pt-4"><span className="brand-data text-[8px] tracking-[0.12em] text-reloop-faint">COMMERCE STATE</span><span className="text-xs font-semibold text-reloop-verified">Connected</span></div>
              </div>

              <div className="absolute bottom-[12%] left-0 w-[42%] max-w-[300px] border border-reloop-line bg-reloop-surface p-5 sm:p-6">
                <a href="https://www.shipstation.com" target="_blank" rel="noreferrer" className="block" aria-label="ShipStation (opens in a new tab)"><Image src="/integrations/shipstation-logo.svg" alt="ShipStation" width={190} height={30} style={{ width: '190px', height: 'auto' }} /></a>
                <div className="mt-6 flex items-center justify-between border-t border-reloop-line pt-4"><span className="brand-data text-[8px] tracking-[0.12em] text-reloop-faint">SHIPMENT STATE</span><span className="text-xs font-semibold text-reloop-verified">Connected</span></div>
              </div>

              <div className="motion-breathe relative z-10 grid h-40 w-40 place-items-center rounded-full border border-reloop-ink bg-reloop-ink shadow-elevated sm:h-52 sm:w-52"><div className="text-center"><Image src="/brand/reloop-symbol-light.svg" alt="Reloop" width={92} height={92} className="mx-auto w-16 sm:w-[92px]" /><p className="mt-4 brand-data text-[8px] font-semibold tracking-[0.16em] text-[#999b93]">RECONCILE</p></div></div>

              <div className="absolute right-0 top-1/2 w-[42%] max-w-[300px] -translate-y-1/2 border border-reloop-line bg-reloop-surface p-5 sm:p-6">
                <div className="flex items-center gap-4 text-reloop-ink"><WarehouseMark /><div><p className="text-xl font-semibold tracking-[-0.035em]">Your 3PL</p><p className="mt-1 brand-data text-[8px] tracking-[0.12em] text-reloop-faint">CUSTOM PROVIDER</p></div></div>
                <div className="mt-6 flex items-center justify-between border-t border-reloop-line pt-4"><span className="brand-data text-[8px] tracking-[0.12em] text-reloop-faint">WAREHOUSE STATE</span><span className="text-xs font-semibold text-reloop-muted">API ready</span></div>
              </div>

              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-reloop-line bg-reloop-paper px-4 py-2 brand-data text-[8px] tracking-[0.12em] text-reloop-muted">PROVIDER CONTEXT PRESERVED END TO END</div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
