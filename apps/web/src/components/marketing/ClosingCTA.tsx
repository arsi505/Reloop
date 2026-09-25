import Image from 'next/image';
import Link from 'next/link';
import { BrandLockup } from '../brand/BrandLockup';
import { EvidenceStamp } from '../brand/SectionIndex';

function ArrowUpRight() {
  return <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="M4 11L11 4M5 4H11V10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

const assurance = [
  ['NO HIDDEN WRITES', 'Sensitive changes remain visible and policy-bound.'],
  ['NO PREMATURE CLOSURE', 'Provider state is verified before resolution.'],
  ['NO LOST CONTEXT', 'Evidence follows the case from detection to outcome.'],
];

const footerGroups = [
  {
    title: 'Product',
    links: [
      ['Why Reloop', '#operational-gap'],
      ['Incident journey', '#incident-journey'],
      ['Safety model', '#safety'],
      ['Integrations', '#integrations'],
    ],
  },
  {
    title: 'Workspace',
    links: [
      ['Operations console', '/dashboard'],
      ['Exceptions', '/exceptions'],
      ['Recoveries', '/recoveries'],
      ['System health', '/health'],
    ],
  },
  {
    title: 'Access',
    links: [
      ['Create workspace', '/register'],
      ['Sign in', '/login'],
      ['Brand system', '/brand-system'],
      ['Identity assets', '/brand-lab'],
    ],
  },
];

export function ClosingCTA() {
  return (
    <>
      <section className="border-t border-reloop-line bg-reloop-signal text-reloop-ink">
        <div className="mx-auto max-w-[1440px] border-x border-black/15">
          <div className="grid lg:grid-cols-[1.22fr_0.78fr]">
            <div data-reveal="up" className="border-b border-black/15 px-5 py-16 sm:px-10 sm:py-20 lg:border-b-0 lg:border-r lg:px-12 lg:py-24">
              <p className="brand-data text-[9px] font-semibold tracking-[0.22em]">PUT ONE ORDER IN FRONT OF THE SYSTEM</p>
              <h2 className="brand-display brand-closing-title mt-7 max-w-5xl">Give every exception a safe way forward.</h2>
              <p className="mt-8 max-w-2xl text-lg leading-8 text-black/65">Start with one organization workspace. Connect the systems your operators already use, then make the next discrepancy easier to understand, control, and prove.</p>
              <div className="mt-7"><EvidenceStamp /></div>
              <div className="mt-10 flex flex-col gap-3 sm:flex-row">
                <Link href="/register" className="brand-button min-h-[52px] bg-reloop-ink px-6 text-reloop-paper hover:bg-[#262720]">Create your workspace <ArrowUpRight /></Link>
                <Link href="/login" className="brand-button min-h-[52px] border border-black/40 px-6 hover:border-black hover:bg-white/15">Sign in to Reloop</Link>
              </div>
            </div>

            <div data-reveal="soft" className="flex flex-col justify-between px-5 py-12 sm:px-10 lg:px-10 lg:py-16">
              <div className="flex items-center justify-between border-b border-black/20 pb-5"><span className="brand-data text-[9px] font-semibold tracking-[0.16em]">OPERATING CONTRACT</span><span className="flex items-center gap-2 brand-data text-[8px] font-semibold tracking-[0.12em]"><span className="h-1.5 w-1.5 rounded-full bg-reloop-ink" /> ACTIVE</span></div>
              <div className="divide-y divide-black/20">
                {assurance.map(([title, copy], index) => (
                  <div key={title} className="grid grid-cols-[35px_1fr] gap-4 py-6">
                    <span className="brand-data text-[9px] font-semibold">0{index + 1}</span>
                    <div><h3 className="brand-data text-[9px] font-semibold tracking-[0.13em]">{title}</h3><p className="mt-2 text-sm leading-6 text-black/65">{copy}</p></div>
                  </div>
                ))}
              </div>
              <div className="mt-8 flex items-center gap-3 border-t border-black/20 pt-6"><Image src="/brand/reloop-symbol-mono.svg" alt="" width={40} height={40} /><p className="brand-data text-[8px] font-semibold tracking-[0.13em]">CHECK → DECIDE → RECOVER → VERIFY</p></div>
            </div>
          </div>
        </div>
      </section>

      <footer className="bg-reloop-ink text-reloop-paper">
        <div className="mx-auto max-w-[1440px] px-5 pt-16 sm:px-10 lg:px-12 lg:pt-20">
          <div className="grid gap-14 border-b border-white/12 pb-16 lg:grid-cols-[1.15fr_1.85fr]">
            <div>
              <Link href="/" aria-label="Reloop homepage" className="inline-block"><BrandLockup tone="light" size="large" /></Link>
              <p className="mt-7 max-w-sm text-sm leading-7 text-[#9fa198]">A reliability and recovery workspace for commerce operations that cannot afford ambiguous order state.</p>
              <div className="mt-8 flex items-center gap-2 brand-data text-[8px] font-semibold tracking-[0.13em] text-[#72d4b4]"><span className="h-1.5 w-1.5 rounded-full bg-reloop-verified shadow-[0_0_0_5px_rgba(8,120,91,0.12)]" /> SYSTEM INTERFACE AVAILABLE</div>
            </div>

            <nav aria-label="Footer navigation" className="grid grid-cols-2 gap-x-8 gap-y-12 sm:grid-cols-3">
              {footerGroups.map((group) => (
                <div key={group.title}>
                  <p className="brand-data text-[9px] font-semibold tracking-[0.16em] text-[#696b64]">{group.title.toUpperCase()}</p>
                  <ul className="mt-6 space-y-4">
                    {group.links.map(([label, href]) => <li key={label}><Link href={href} className="text-sm font-semibold text-[#b9bbb3] transition-colors hover:text-white">{label}</Link></li>)}
                  </ul>
                </div>
              ))}
            </nav>
          </div>

          <div className="grid gap-6 py-7 brand-data text-[8px] tracking-[0.11em] text-[#666860] sm:grid-cols-[1fr_auto] sm:items-center">
            <p>© 2026 RELOOP · RELIABILITY FOR COMMERCE OPERATIONS</p>
            <div className="flex flex-wrap gap-x-6 gap-y-3"><span>TENANT ISOLATED</span><span>APPROVAL GUARDED</span><span>EVIDENCE FIRST</span></div>
          </div>
        </div>
      </footer>
    </>
  );
}
