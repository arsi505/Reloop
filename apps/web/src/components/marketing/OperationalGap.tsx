import Image from 'next/image';

function CheckIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2.5 7.2L5.5 10L11.5 3.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function WarehouseMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" fill="none" aria-hidden="true">
      <path d="M9 23L28 11L47 23V46H9V23Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M18 46V28H38V46M18 34H38M24 28V46M32 28V46" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function OperationalGap() {
  return (
    <>
      <section id="problem" className="border-y border-reloop-line bg-reloop-paper">
        <div className="mx-auto grid max-w-[1280px] gap-10 px-5 py-14 sm:px-8 sm:py-16 lg:grid-cols-[0.88fr_1.12fr] lg:items-center lg:gap-16 lg:px-12 lg:py-16">
          <div data-reveal="up">
            <p className="text-sm font-semibold text-reloop-signal-hover">The problem</p>
            <h2 className="brand-display mt-5 max-w-2xl text-[clamp(2.65rem,4.1vw,4rem)] leading-[0.96] tracking-[-0.055em]">One order can tell three different stories.</h2>
            <p className="mt-7 max-w-xl text-lg leading-8 text-reloop-muted">Shopify may show an order as unfulfilled, ShipStation may show it in transit, while your warehouse or 3PL reports that it has already shipped. Reloop catches these mismatches and brings the relevant details together.</p>
          </div>

          <div data-reveal="soft" className="rounded-xl border border-reloop-line bg-reloop-canvas p-4 shadow-subtle sm:p-6">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-reloop-line bg-white p-5">
                <Image src="/integrations/shopify-logo.svg" alt="Shopify" width={116} height={34} className="h-auto w-[110px]" />
                <p className="mt-7 text-sm text-reloop-muted">Order status</p>
                <p className="mt-1 text-lg font-semibold">Unfulfilled</p>
              </div>
              <div className="rounded-lg border border-reloop-line bg-white p-5">
                <Image src="/integrations/shipstation-logo.svg" alt="ShipStation" width={150} height={24} style={{ width: '145px', height: 'auto' }} />
                <p className="mt-7 text-sm text-reloop-muted">Shipment status</p>
                <p className="mt-1 text-lg font-semibold">In transit</p>
              </div>
              <div className="rounded-lg border border-reloop-line bg-white p-5">
                <div className="flex min-h-[34px] items-center gap-2 text-reloop-ink"><WarehouseMark /><span className="text-sm font-semibold">Warehouse / 3PL</span></div>
                <p className="mt-7 text-sm text-reloop-muted">Warehouse status</p>
                <p className="mt-1 text-lg font-semibold">Shipped</p>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-3 rounded-lg border border-[#ffc6b7] bg-[#fff3ef] px-4 py-4 text-sm">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-reloop-signal text-white">!</span>
              <div><p className="font-semibold text-reloop-ink">Reloop detected a mismatch</p><p className="mt-0.5 text-reloop-muted">The relevant order, shipment, and warehouse details are attached to one case.</p></div>
            </div>
          </div>
        </div>
      </section>

      <section id="product" className="bg-reloop-canvas">
        <div className="mx-auto max-w-[1280px] px-5 py-14 sm:px-8 sm:py-16 lg:px-12 lg:py-16">
          <div data-reveal="up" className="grid gap-7 lg:grid-cols-[1fr_0.72fr] lg:items-end lg:gap-16">
            <div>
              <p className="text-sm font-semibold text-reloop-signal-hover">The Reloop product</p>
              <h2 className="brand-display mt-5 max-w-4xl text-[clamp(2.65rem,4.1vw,4rem)] leading-[0.96] tracking-[-0.055em]">Everything your team needs to resolve the order, in one case.</h2>
            </div>
            <p className="max-w-xl text-lg leading-8 text-reloop-muted">Reloop keeps the evidence, decision, recovery action, and verification together so operators do not have to reconstruct the incident across multiple systems.</p>
          </div>

          <div data-reveal="scale" className="mt-8 overflow-hidden rounded-xl border border-[#dedad1] bg-white shadow-[0_24px_65px_rgba(36,31,24,0.1)] lg:max-h-[640px]">
            <div className="flex min-h-12 items-center justify-between border-b border-[#e9e6df] bg-[#fbfaf7] px-4 sm:px-5">
              <div className="flex items-center gap-3"><Image src="/brand/reloop-symbol.svg" alt="" width={28} height={28} /><span className="text-sm font-semibold">Exceptions</span></div>
              <div className="flex items-center gap-2 text-xs text-reloop-muted"><span className="h-2 w-2 rounded-full bg-reloop-verified" />Connected</div>
            </div>

            <div className="grid lg:grid-cols-[230px_minmax(0,1fr)]">
              <aside className="hidden bg-reloop-ink p-5 text-reloop-paper lg:block" aria-label="Reloop application preview">
                <Image src="/brand/reloop-wordmark-light.svg" alt="Reloop" width={98} height={28} style={{ width: '98px', height: 'auto' }} />
                <nav className="mt-10 space-y-1 text-sm">
                  <div className="px-3 py-2.5 text-[#999b93]">Overview</div>
                  <div className="border-l-2 border-reloop-signal bg-white/[0.07] px-3 py-2.5 font-semibold text-white">Exceptions</div>
                  <div className="px-3 py-2.5 text-[#999b93]">Orders</div>
                  <div className="px-3 py-2.5 text-[#999b93]">Recoveries</div>
                  <div className="px-3 py-2.5 text-[#999b93]">Integrations</div>
                </nav>
              </aside>

              <div className="min-w-0 bg-[#f8f7f3] p-4 sm:p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2"><span className="rounded bg-[#eeece6] px-2 py-1 text-xs font-semibold">ORDER_STATE_MISMATCH</span><span className="rounded-full border border-[#ffc6b7] bg-[#fff2ee] px-2.5 py-1 text-xs font-semibold text-[#b93b1f]">Needs review</span></div>
                    <h3 className="mt-3 text-2xl font-semibold tracking-[-0.04em]">Shipment state conflicts with order status</h3>
                    <p className="mt-2 text-sm text-reloop-muted">Detected for order #10482 · Case RL-2048</p>
                  </div>
                  <span className="text-xs text-reloop-faint">Detected 10:43 UTC</span>
                </div>

                <div className="mt-5 grid gap-3 xl:grid-cols-[0.86fr_1.14fr]">
                  <div className="space-y-3">
                    <div className="rounded-lg border border-[#e6e3dc] bg-white p-4">
                      <h4 className="text-sm font-semibold">Provider evidence</h4>
                      <div className="mt-4 space-y-3">
                        <div className="flex items-center justify-between gap-4 border-b border-[#f0eee8] pb-3 text-sm"><span className="flex items-center gap-2 text-reloop-muted"><Image src="/integrations/shopify-mark.svg" alt="Shopify" width={20} height={20} />Shopify order state</span><span className="font-semibold">Unfulfilled</span></div>
                        <div className="flex items-center justify-between gap-4 border-b border-[#f0eee8] pb-3 text-sm"><span className="flex items-center gap-2 text-reloop-muted"><Image src="/integrations/shipstation-mark.svg" alt="ShipStation" width={20} height={20} />ShipStation shipment state</span><span className="font-semibold">In transit</span></div>
                        <div className="flex items-center justify-between gap-4 text-sm"><span className="flex items-center gap-2 text-reloop-muted"><WarehouseMark size={20} />Warehouse / 3PL state</span><span className="font-semibold">Shipped</span></div>
                      </div>
                    </div>
                    <div className="rounded-lg border border-[#e6e3dc] bg-white p-4">
                      <h4 className="text-sm font-semibold">Relevant history</h4>
                      <div className="mt-4 space-y-3 text-sm">
                        <div className="flex gap-3"><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[#4c8fb2]" /><div><p className="font-medium">Shipment marked in transit</p><p className="mt-0.5 text-xs text-reloop-muted">ShipStation · 10:42 UTC</p></div></div>
                        <div className="flex gap-3"><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-reloop-signal" /><div><p className="font-medium">Mismatch detected</p><p className="mt-0.5 text-xs text-reloop-muted">Reloop · 10:43 UTC</p></div></div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-[#e6e3dc] bg-white p-5">
                    <div className="flex items-center justify-between gap-4"><h4 className="text-sm font-semibold">Recommended recovery</h4><span className="rounded-full bg-[#fff2ee] px-2.5 py-1 text-xs font-semibold text-[#b93b1f]">Approval required</span></div>
                    <p className="mt-4 text-lg font-semibold tracking-[-0.025em]">Review the order fulfillment state</p>
                    <p className="mt-2 text-sm leading-6 text-reloop-muted">Compare the shipment and warehouse evidence before approving the next step for the affected Shopify order.</p>

                    <div className="mt-4 rounded-lg border border-[#eee9df] bg-[#fbfaf7] p-4">
                      <div className="flex items-center justify-between text-sm"><span className="text-reloop-muted">Action scope</span><span className="font-semibold">Order #10482</span></div>
                      <div className="mt-3 flex items-center justify-between border-t border-[#e8e4dc] pt-3 text-sm"><span className="text-reloop-muted">Verification</span><span className="font-semibold">Recheck connected systems</span></div>
                    </div>

                    <button type="button" className="mt-4 min-h-11 w-full rounded-md bg-reloop-ink px-4 text-sm font-semibold text-reloop-paper">Review approval</button>

                    <div className="mt-4 border-t border-[#e8e4dc] pt-4">
                      <p className="text-xs font-semibold text-reloop-muted">Recovery progress</p>
                      <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        <div className="flex items-center gap-2 text-xs font-medium"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-reloop-verified text-white"><CheckIcon /></span>Evidence ready</div>
                        <div className="flex items-center gap-2 text-xs font-medium"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#fff0eb] text-reloop-signal-hover">2</span>Approval</div>
                        <div className="flex items-center gap-2 text-xs text-reloop-faint"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#eeece6]">3</span>Verification</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
