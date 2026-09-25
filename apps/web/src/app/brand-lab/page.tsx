import Image from 'next/image';
import Link from 'next/link';

const downloads = [
  ['Primary symbol', '/brand/reloop-symbol.svg'],
  ['Light symbol', '/brand/reloop-symbol-light.svg'],
  ['Monochrome symbol', '/brand/reloop-symbol-mono.svg'],
  ['Animated symbol', '/brand/reloop-symbol-animated.svg'],
  ['Dark wordmark', '/brand/reloop-wordmark-dark.svg'],
  ['Light wordmark', '/brand/reloop-wordmark-light.svg'],
  ['Favicon', '/brand/reloop-favicon.svg'],
];

function Label({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[9px] font-semibold tracking-[0.22em] text-[#74766f]">{children}</p>;
}

export default function BrandLabPage() {
  return (
    <main className="min-h-screen bg-[#f3efe6] text-[#171814] selection:bg-[#ff5c35] selection:text-white">
      <header className="border-b border-[#171814]/15">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-5 py-5 sm:px-8 lg:px-12">
          <Link href="/" className="font-mono text-[11px] font-semibold tracking-[0.18em] text-[#55574f] hover:text-[#171814]">RELOOP / BRAND LAB</Link>
          <span className="rounded-full border border-[#171814]/20 px-3 py-1.5 font-mono text-[9px] tracking-[0.18em]">DIRECTION 02 · SELECTED</span>
        </div>
      </header>

      <section className="mx-auto grid min-h-[720px] max-w-[1440px] border-x border-[#171814]/15 lg:grid-cols-[0.92fr_1.08fr]">
        <div className="flex flex-col justify-between border-b border-[#171814]/15 p-6 sm:p-10 lg:border-b-0 lg:border-r lg:p-12">
          <div>
            <p className="font-mono text-[10px] font-semibold tracking-[0.24em] text-[#df4625]">THE RECONCILE MARK</p>
            <h1 className="mt-7 max-w-2xl text-[clamp(3.5rem,7vw,7rem)] font-semibold leading-[0.87] tracking-[-0.075em]">Two signals. One verified truth.</h1>
          </div>
          <div className="mt-16 grid gap-8 border-t border-[#171814]/15 pt-8 sm:grid-cols-2">
            <p className="text-sm leading-6 text-[#5e6059]">Two provider states enter independently. Reloop reconciles them into one operational outcome with verification built into the endpoint.</p>
            <div className="space-y-3 font-mono text-[9px] font-semibold tracking-[0.16em] text-[#55574f]">
              <p>01 · PROVIDER SIGNALS</p><p>02 · RECONCILIATION</p><p>03 · VERIFIED STATE</p>
            </div>
          </div>
        </div>
        <div className="relative grid min-h-[560px] place-items-center overflow-hidden bg-[#f8f5ed] p-10">
          <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'linear-gradient(#171814 1px, transparent 1px), linear-gradient(90deg, #171814 1px, transparent 1px)', backgroundSize: '32px 32px' }} />
          <div className="absolute left-8 top-8 font-mono text-[9px] tracking-[0.18em] text-[#777970]">PRIMARY SYMBOL / 01</div>
          <Image src="/brand/reloop-symbol-animated.svg" alt="Animated Reloop reconcile mark" width={380} height={380} priority className="relative h-[min(55vw,380px)] w-[min(55vw,380px)]" />
          <div className="absolute bottom-8 right-8 flex items-center gap-2 font-mono text-[9px] tracking-[0.16em] text-[#777970]"><span className="h-2 w-2 rounded-full bg-[#ff5c35]" /> VERIFIED OUTPUT</div>
        </div>
      </section>

      <section className="mx-auto max-w-[1440px] border-x border-[#171814]/15 px-5 py-20 sm:px-10 lg:px-12 lg:py-28">
        <div className="mb-12 grid gap-6 lg:grid-cols-2 lg:items-end">
          <div><Label>IDENTITY SYSTEM</Label><h2 className="mt-4 text-4xl font-semibold tracking-[-0.055em] sm:text-6xl">One mark, every environment.</h2></div>
          <p className="max-w-lg text-sm leading-7 text-[#60625b] lg:justify-self-end">The system keeps its meaning in full color, one color, light interfaces, dark interfaces, and compact product surfaces.</p>
        </div>

        <div className="grid gap-px overflow-hidden border border-[#171814]/20 bg-[#171814]/20 md:grid-cols-2">
          <div className="grid min-h-[420px] place-items-center bg-[#f8f5ed] p-8"><Image src="/brand/reloop-symbol.svg" alt="Reloop primary symbol" width={220} height={220} /><span className="self-end justify-self-start"><Label>PRIMARY / IVORY</Label></span></div>
          <div className="grid min-h-[420px] place-items-center bg-[#12130f] p-8"><Image src="/brand/reloop-symbol-light.svg" alt="Reloop light symbol" width={220} height={220} /><span className="self-end justify-self-start"><p className="font-mono text-[9px] font-semibold tracking-[0.22em] text-[#999b94]">REVERSED / CHARCOAL</p></span></div>
          <div className="grid min-h-[260px] place-items-center bg-white p-8"><Image src="/brand/reloop-wordmark-dark.svg" alt="Reloop dark wordmark" width={310} height={72} /><span className="self-end justify-self-start"><Label>HORIZONTAL LOCKUP</Label></span></div>
          <div className="grid min-h-[260px] place-items-center bg-[#ff5c35] p-8"><Image src="/brand/reloop-symbol-mono.svg" alt="Reloop monochrome mark" width={150} height={150} /><span className="self-end justify-self-start"><p className="font-mono text-[9px] font-semibold tracking-[0.22em]">MONOCHROME / SIGNAL</p></span></div>
        </div>
      </section>

      <section className="bg-[#12130f] text-[#f8f5ed]">
        <div className="mx-auto max-w-[1440px] px-5 py-20 sm:px-8 lg:px-12 lg:py-24">
          <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr]">
            <div><p className="font-mono text-[9px] font-semibold tracking-[0.22em] text-[#ff6a43]">SMALL-SCALE TEST</p><h2 className="mt-4 text-4xl font-semibold tracking-[-0.05em]">Built to survive the sidebar.</h2><p className="mt-5 max-w-md text-sm leading-7 text-[#aaaca5]">The shape remains readable without text, gradients, shadows, or a colored container.</p></div>
            <div className="flex flex-wrap items-end gap-7 border border-white/15 p-7 sm:gap-12 sm:p-10">
              {[64, 48, 32, 24, 16].map((size) => <div key={size} className="text-center"><span className="grid place-items-center rounded-[24%] bg-[#f8f5ed]" style={{ width: size + 20, height: size + 20 }}><Image src="/brand/reloop-symbol.svg" alt="" width={size} height={size} /></span><span className="mt-3 block font-mono text-[8px] text-[#85877f]">{size}px</span></div>)}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1440px] border-x border-[#171814]/15 px-5 py-20 sm:px-10 lg:px-12">
        <div className="grid gap-10 lg:grid-cols-[0.7fr_1.3fr]">
          <div><Label>ASSET PACKAGE</Label><h2 className="mt-4 text-4xl font-semibold tracking-[-0.05em]">Ready for product use.</h2></div>
          <div className="border-t border-[#171814]/20">
            {downloads.map(([name, href], index) => <a key={href} href={href} download className="group flex items-center justify-between border-b border-[#171814]/20 py-5 text-sm font-semibold"><span><span className="mr-5 font-mono text-[9px] text-[#8a8c84]">{String(index + 1).padStart(2, '0')}</span>{name}</span><span className="font-mono text-[9px] tracking-[0.15em] text-[#df4625] transition-transform group-hover:translate-x-1">SVG ↓</span></a>)}
          </div>
        </div>
      </section>

      <footer className="bg-[#ff5c35] text-[#171814]"><div className="mx-auto flex max-w-[1440px] flex-col justify-between gap-8 px-5 py-12 sm:px-8 lg:flex-row lg:items-end lg:px-12"><div><p className="font-mono text-[9px] font-semibold tracking-[0.2em]">STEP 01 · COMPLETE</p><p className="mt-3 max-w-3xl text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">The Reconcile identity is ready for the new brand system.</p></div><Link href="/brand-system" className="font-mono text-[10px] font-semibold tracking-[0.16em] underline underline-offset-8">VIEW BRAND FOUNDATION →</Link></div></footer>
    </main>
  );
}
