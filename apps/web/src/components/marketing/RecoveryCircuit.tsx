'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

const stages = [
  {
    name: 'Review',
    status: 'Mismatch detected',
    title: 'Provider states conflict',
    description: 'Shopify, ShipStation, and warehouse status do not describe the same fulfillment outcome.',
    action: 'Review evidence',
    tone: 'signal',
  },
  {
    name: 'Approval',
    status: 'Approval required',
    title: 'Recovery is ready',
    description: 'The recommended update is scoped to this order and is waiting for an authorized operator.',
    action: 'Approve recovery',
    tone: 'signal',
  },
  {
    name: 'Recovery',
    status: 'Recovery coordinated',
    title: 'The approved next step is tracked',
    description: 'Reloop keeps the authorized action and resulting provider details attached to the case.',
    action: 'Track recovery',
    tone: 'dark',
  },
  {
    name: 'Verification',
    status: 'Verified',
    title: 'Provider states are aligned',
    description: 'The connected systems were checked again before the case was marked resolved.',
    action: 'View outcome',
    tone: 'verified',
  },
] as const;

function ProviderState({ provider, label, value }: { provider: 'Shopify' | 'ShipStation'; label: string; value: string }) {
  const logo = provider === 'Shopify' ? '/integrations/shopify-logo.svg' : '/integrations/shipstation-logo.svg';
  const dimensions = provider === 'Shopify' ? { width: 82, height: 24 } : { width: 108, height: 17 };

  return (
    <div className="rounded-lg border border-[#e8e5dd] bg-white p-3.5 shadow-[0_1px_2px_rgba(23,24,20,0.03)] sm:p-4">
      <div className="flex min-h-6 items-center">
        <Image src={logo} alt={provider} width={dimensions.width} height={dimensions.height} style={{ width: `${dimensions.width}px`, height: 'auto' }} />
      </div>
      <p className="mt-3 text-xs text-[#787970]">{label}</p>
      <p className="mt-1 text-sm font-semibold text-[#181914]">{value}</p>
    </div>
  );
}

export function RecoveryCircuit() {
  const [stage, setStage] = useState(0);
  const [playing, setPlaying] = useState(true);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPlaying(false);
      return;
    }

    if (!playing) return;
    const timer = window.setTimeout(() => setStage((current) => (current + 1) % stages.length), 3600);
    return () => window.clearTimeout(timer);
  }, [playing, stage]);

  const current = stages[stage];

  return (
    <div ref={frameRef} className="overflow-hidden rounded-xl border border-[#ddd9cf] bg-[#fbfaf7] shadow-[0_30px_80px_rgba(36,31,24,0.12),0_2px_5px_rgba(36,31,24,0.05)]">
      <div className="flex h-12 items-center justify-between border-b border-[#e4e0d7] bg-white/90 px-4 sm:px-5">
        <div className="flex items-center gap-3">
          <Image src="/brand/reloop-symbol.svg" alt="" width={25} height={25} />
          <span className="text-xs font-semibold text-[#35362f]">Exception RL-2048</span>
        </div>
        <span className="flex items-center gap-2 text-xs font-medium text-[#6d6f66]"><span className="h-2 w-2 rounded-full bg-reloop-signal" /> Needs review</span>
      </div>

      <div className="grid min-h-[440px] md:grid-cols-[136px_minmax(0,1fr)]">
        <aside className="hidden border-r border-white/10 bg-reloop-ink px-3 py-5 text-reloop-paper md:block" aria-label="Product preview navigation">
          <p className="px-3 text-[11px] font-medium text-[#8f9189]">Operations</p>
          <div className="mt-4 space-y-1 text-xs">
            <div className="px-3 py-2.5 text-[#9ea098]">Overview</div>
            <div className="border-l-2 border-reloop-signal bg-white/[0.07] px-3 py-2.5 font-semibold text-white">Exceptions</div>
            <div className="px-3 py-2.5 text-[#9ea098]">Orders</div>
            <div className="px-3 py-2.5 text-[#9ea098]">Recoveries</div>
          </div>
        </aside>

        <div className="min-w-0 p-4 sm:p-5">
          <div className="flex flex-col gap-3 border-b border-[#e7e3da] pb-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-medium text-[#7a7b73]">Order #10482</p>
              <h2 className="mt-2 text-xl font-semibold tracking-[-0.035em] text-[#181914]">Shipment state mismatch</h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-[#6d6f66]">The order, shipment, and warehouse status do not agree.</p>
            </div>
            <span className="w-fit rounded-full border border-[#ffc6b7] bg-[#fff2ee] px-3 py-1.5 text-xs font-semibold text-[#b93b1f]">Open exception</span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <ProviderState provider="Shopify" label="Order status" value="Unfulfilled" />
            <ProviderState provider="ShipStation" label="Shipment status" value="In transit" />
          </div>

          <div key={stage} className={`mt-4 rounded-lg border p-4 sm:p-5 ${current.tone === 'verified' ? 'border-[#a9ddca] bg-[#effaf5]' : current.tone === 'dark' ? 'border-reloop-ink bg-reloop-ink text-reloop-paper' : 'border-[#f0c2b7] bg-[#fff7f4]'}`}>
            <div className="flex items-center justify-between gap-4">
              <span className={`text-xs font-semibold ${current.tone === 'verified' ? 'text-reloop-verified' : current.tone === 'dark' ? 'text-[#b9bbb3]' : 'text-reloop-signal-hover'}`}>{current.status}</span>
              <span className={`text-xs ${current.tone === 'dark' ? 'text-[#8f9189]' : 'text-[#777970]'}`}>Case activity</span>
            </div>
            <h3 className="mt-3 text-lg font-semibold tracking-[-0.025em]">{current.title}</h3>
            <p className={`mt-2 text-sm leading-6 ${current.tone === 'dark' ? 'text-[#b9bbb3]' : 'text-[#64665e]'}`}>{current.description}</p>
            <div className={`mt-4 flex items-center justify-between border-t pt-3 ${current.tone === 'dark' ? 'border-white/10' : 'border-black/10'}`}>
              <span className={`text-xs ${current.tone === 'dark' ? 'text-[#8f9189]' : 'text-[#777970]'}`}>Recommended action</span>
              <span className="text-xs font-semibold">{current.action}</span>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-4 gap-1" role="group" aria-label="Recovery preview states">
            {stages.map((item, index) => (
              <button
                key={item.name}
                type="button"
                aria-pressed={stage === index}
                onClick={() => { setStage(index); setPlaying(false); }}
                className={`min-h-11 border-t-2 px-1 pt-2 text-left text-[11px] font-semibold transition-colors sm:text-xs ${stage === index ? 'border-reloop-signal text-reloop-ink' : 'border-[#ddd9cf] text-[#8a8c84] hover:border-[#aaa69d] hover:text-reloop-ink'}`}
              >
                {item.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
