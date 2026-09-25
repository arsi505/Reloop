import Image from 'next/image';
import Link from 'next/link';
import { StatusBadge } from '../../components/ui/StatusBadge';

const colors = [
  { name: 'Canvas', token: '--color-canvas', hex: '#F3EFE6', text: 'text-reloop-ink' },
  { name: 'Paper', token: '--color-paper', hex: '#F8F5ED', text: 'text-reloop-ink' },
  { name: 'Ink', token: '--color-ink', hex: '#171814', text: 'text-white' },
  { name: 'Signal', token: '--color-signal', hex: '#FF5C35', text: 'text-reloop-ink' },
  { name: 'Verified', token: '--color-verified', hex: '#08785B', text: 'text-white' },
  { name: 'Warning', token: '--color-warning', hex: '#9B620C', text: 'text-white' },
];

function Eyebrow({ children, light = false }: { children: React.ReactNode; light?: boolean }) {
  return <p className={`brand-data text-[9px] font-semibold tracking-[0.22em] ${light ? 'text-[#ff7a58]' : 'text-reloop-signal-hover'}`}>{children}</p>;
}

export default function BrandSystemPage() {
  return (
    <main className="brand-noise min-h-screen bg-reloop-canvas text-reloop-ink">
      <header className="border-b border-reloop-line">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-5 py-5 sm:px-8 lg:px-12">
          <Link href="/brand-lab" aria-label="Back to Reloop identity">
            <Image src="/brand/reloop-wordmark-dark.svg" alt="Reloop" width={181} height={42} priority />
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden brand-data text-[9px] tracking-[0.16em] text-reloop-muted sm:inline">FOUNDATION / 02</span>
            <span className="h-2 w-2 rounded-full bg-reloop-verified" />
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-[1440px] border-x border-reloop-line">
        <div className="grid min-h-[680px] lg:grid-cols-[1.15fr_0.85fr]">
          <div className="flex flex-col justify-between border-b border-reloop-line p-6 sm:p-10 lg:border-b-0 lg:border-r lg:p-12">
            <div>
              <Eyebrow>RELOOP BRAND FOUNDATION</Eyebrow>
              <h1 className="brand-display mt-8 max-w-4xl text-[clamp(4rem,9vw,8.5rem)]">Precise under pressure.</h1>
            </div>
            <p className="mt-16 max-w-xl text-lg leading-8 text-reloop-muted">A warm, operational design language built around clear evidence, intentional intervention, and verified outcomes.</p>
          </div>
          <div className="brand-grid relative flex min-h-[500px] flex-col justify-between overflow-hidden bg-reloop-paper p-8 sm:p-12">
            <div className="flex justify-between brand-data text-[9px] tracking-[0.16em] text-reloop-faint"><span>SYSTEM SIGNAL</span><span>02 / ACTIVE</span></div>
            <div className="relative mx-auto w-full max-w-md">
              <Image src="/brand/reloop-symbol-animated.svg" alt="Reloop reconcile mark" width={360} height={360} className="mx-auto w-[70%]" />
              <div className="mt-10 grid grid-cols-3 gap-2 brand-data text-[8px] tracking-[0.12em] text-reloop-muted"><span>INPUT A</span><span className="text-center">RECONCILE</span><span className="text-right">VERIFIED</span></div>
            </div>
            <div className="flex items-center gap-2 brand-data text-[9px] tracking-[0.14em] text-reloop-verified"><span className="h-2 w-2 animate-signal-pulse rounded-full bg-reloop-signal" />FOUNDATION CONNECTED</div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1440px] border-x border-t border-reloop-line px-5 py-20 sm:px-10 lg:px-12 lg:py-28">
        <div className="mb-12 grid gap-6 lg:grid-cols-2 lg:items-end"><div><Eyebrow>01 / COLOR</Eyebrow><h2 className="brand-display mt-5 text-5xl sm:text-7xl">Warm neutrals.<br />Decisive signals.</h2></div><p className="max-w-lg text-sm leading-7 text-reloop-muted lg:justify-self-end">Orange marks intervention—not decoration. Green is reserved for verified state. Warm neutrals reduce visual fatigue in high-density operational views.</p></div>
        <div className="grid gap-px overflow-hidden border border-reloop-line bg-reloop-line sm:grid-cols-2 lg:grid-cols-3">
          {colors.map((color) => <div key={color.name} className={`flex min-h-[210px] flex-col justify-between p-6 ${color.text}`} style={{ background: `var(${color.token})` }}><span className="brand-data text-[9px] font-semibold tracking-[0.18em]">{color.name.toUpperCase()}</span><div className="brand-data text-[10px]"><p>{color.hex}</p><p className="mt-1 opacity-60">{color.token}</p></div></div>)}
        </div>
      </section>

      <section className="bg-reloop-ink text-reloop-paper">
        <div className="mx-auto max-w-[1440px] px-5 py-20 sm:px-10 lg:px-12 lg:py-28">
          <div className="grid gap-12 lg:grid-cols-[0.55fr_1.45fr]">
            <div><Eyebrow light>02 / TYPOGRAPHY</Eyebrow><p className="mt-5 max-w-sm text-sm leading-7 text-[#aaaDA5]">Instrument Sans carries the human voice. IBM Plex Mono separates system facts from product storytelling.</p></div>
            <div>
              <p className="brand-display text-[clamp(4.5rem,11vw,10rem)]">Aa</p>
              <p className="brand-display mt-4 max-w-4xl text-5xl sm:text-7xl">Reliability is a state you can prove.</p>
              <div className="mt-16 grid gap-8 border-t border-white/15 pt-8 sm:grid-cols-2">
                <div><p className="brand-data text-[9px] tracking-[0.18em] text-[#7f8179]">INSTRUMENT SANS VARIABLE</p><p className="mt-4 text-xl">Human-facing product and brand communication.</p></div>
                <div><p className="brand-data text-[9px] tracking-[0.18em] text-[#7f8179]">IBM PLEX MONO</p><p className="brand-data mt-4 text-sm leading-7 text-[#c4c6be]">ORDER #RL-2048 · 10:42:08<br />STATE / VERIFIED</p></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1440px] border-x border-reloop-line px-5 py-20 sm:px-10 lg:px-12 lg:py-28">
        <div className="mb-12"><Eyebrow>03 / SURFACES & CONTROLS</Eyebrow><h2 className="brand-display mt-5 text-5xl sm:text-7xl">Quiet structure.<br />Clear hierarchy.</h2></div>
        <div className="grid gap-5 lg:grid-cols-2">
          <article className="brand-surface p-7 sm:p-9">
            <div className="flex items-start justify-between"><div><p className="brand-data text-[9px] tracking-[0.16em] text-reloop-faint">EXCEPTION / RL-2048</p><h3 className="mt-4 text-2xl font-semibold tracking-[-0.035em]">Fulfillment state mismatch</h3></div><StatusBadge status="REQUIRE_APPROVAL" /></div>
            <p className="mt-5 max-w-xl text-sm leading-7 text-reloop-muted">Shopify reports unfulfilled while the connected shipping provider reports the package in transit.</p>
            <div className="mt-8 flex flex-wrap gap-3"><button className="brand-button brand-button-primary">Review recovery →</button><button className="brand-button brand-button-secondary">Inspect evidence</button></div>
          </article>
          <article className="rounded-[var(--radius-panel)] border border-white/10 bg-reloop-ink p-7 text-reloop-paper shadow-elevated sm:p-9">
            <div className="flex items-center justify-between"><Eyebrow light>VERIFICATION RECORD</Eyebrow><StatusBadge status="RESOLVED" /></div>
            <p className="brand-data mt-14 text-5xl tracking-[-0.06em]">10:42:08</p><p className="mt-3 text-sm text-[#adafa7]">Cross-system state checked and evidence preserved.</p>
            <div className="mt-10 h-px bg-white/10"><div className="h-px w-[82%] bg-reloop-signal" /></div>
          </article>
        </div>
        <div className="mt-5 grid gap-5 sm:grid-cols-3">
          {['RESOLVED', 'INVESTIGATING', 'FAILED'].map((status) => <div key={status} className="brand-surface flex items-center justify-between p-5"><span className="brand-data text-[9px] tracking-[0.14em] text-reloop-faint">SYSTEM STATE</span><StatusBadge status={status} /></div>)}
        </div>
      </section>

      <section className="border-t border-reloop-line bg-reloop-paper">
        <div className="mx-auto grid max-w-[1440px] gap-10 px-5 py-16 sm:px-10 lg:grid-cols-[1fr_auto] lg:items-end lg:px-12">
          <div><Eyebrow>STEP 02 · COMPLETE</Eyebrow><p className="brand-display mt-5 max-w-4xl text-4xl sm:text-6xl">The visual rules are ready for the homepage.</p></div>
          <Link href="/" className="brand-button brand-button-primary">Return to homepage →</Link>
        </div>
      </section>
    </main>
  );
}
