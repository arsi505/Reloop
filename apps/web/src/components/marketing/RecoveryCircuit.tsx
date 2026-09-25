'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';

const stages = [
  {
    short: 'Signals',
    eyebrow: 'SIGNALS NORMALIZED',
    title: 'Two provider states received.',
    pathLabel: 'Comparing states',
    gateLabel: 'Policy pending',
    footer: 'Signals ready for comparison',
  },
  {
    short: 'Compare',
    eyebrow: 'DISCREPANCY CONFIRMED',
    title: 'One order. Two realities.',
    pathLabel: 'Verify shipment',
    gateLabel: 'Policy evaluating',
    footer: 'Recovery path prepared',
  },
  {
    short: 'Guard',
    eyebrow: 'HUMAN GATE ACTIVE',
    title: 'Judgment before action.',
    pathLabel: 'Reconcile fulfillment',
    gateLabel: 'Approval required',
    footer: 'Waiting for authorized operator',
  },
  {
    short: 'Verify',
    eyebrow: 'STATE VERIFIED',
    title: 'The loop is closed.',
    pathLabel: 'Provider state aligned',
    gateLabel: 'Evidence recorded',
    footer: 'Recovery verified safely',
  },
];

function CheckMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M2.5 6.8L5.2 9.3L10.6 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PauseIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3.5 2.5V9.5M8.5 2.5V9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3.5 2.3L9.2 6L3.5 9.7V2.3Z" fill="currentColor" /></svg>
  );
}

function ProviderNode({
  provider,
  label,
  value,
  tone,
  active,
}: {
  provider: string;
  label: string;
  value: string;
  tone: 'shopify' | 'shipstation';
  active: boolean;
}) {
  const colors = tone === 'shopify'
    ? 'bg-[#eef5df] text-[#527320] border-[#cdddb1]'
    : 'bg-[#e8f2f8] text-[#245f80] border-[#bfd5e1]';

  return (
    <div className={`circuit-provider relative z-10 w-full rounded-[3px] border bg-reloop-surface p-4 sm:p-5 ${active ? 'is-active border-reloop-signal/50' : 'border-reloop-line'}`}>
      <div className="flex items-center justify-between gap-3">
        <span className={`rounded-full border px-2.5 py-1 brand-data text-[8px] font-semibold tracking-[0.1em] ${colors}`}>{provider}</span>
        <span className={`h-1.5 w-1.5 rounded-full ${active ? 'animate-signal-pulse bg-reloop-signal' : 'bg-reloop-line-strong'}`} />
      </div>
      <p className="mt-5 brand-data text-[8px] tracking-[0.15em] text-reloop-faint">{label}</p>
      <p className="mt-2 text-sm font-semibold tracking-[-0.02em] text-reloop-ink">{value}</p>
    </div>
  );
}

export function RecoveryCircuit() {
  const [stage, setStage] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      setPlaying(false);
      setStage(3);
    }
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setStage((current) => (current + 1) % stages.length), 2400);
    return () => window.clearInterval(timer);
  }, [playing]);

  const current = stages[stage];
  const pathActive = stage >= 1;
  const gateActive = stage >= 2;
  const verified = stage === 3;

  return (
    <div className="relative mx-auto flex h-full w-full max-w-[680px] flex-col justify-center pt-10">
      <div className="absolute right-0 top-0 flex items-center gap-2 brand-data text-[8px] font-semibold tracking-[0.15em] text-reloop-faint">
        <span className={`h-2 w-2 rounded-full ${playing ? 'animate-signal-pulse bg-reloop-verified' : 'bg-reloop-faint'}`} />
        {playing ? 'LIVE RECONCILIATION' : 'SEQUENCE PAUSED'}
      </div>

      <div className="relative grid gap-5 sm:grid-cols-[minmax(180px,1fr)_100px_minmax(190px,1fr)] sm:items-center sm:gap-3">
        <div className="flex flex-col gap-4 sm:gap-28">
          <ProviderNode provider="SHOPIFY" label="FULFILLMENT STATE" value="Unfulfilled" tone="shopify" active={stage === 0} />
          <ProviderNode provider="SHIPSTATION" label="SHIPMENT STATE" value="In transit" tone="shipstation" active={stage === 0} />
        </div>

        <div className="relative hidden h-[330px] sm:block">
          <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 330" fill="none" aria-hidden="true">
            <path d="M0 78H18C45 78 41 165 69 165H100" stroke="#C2BDB3" strokeWidth="1.5" />
            <path d="M0 252H18C45 252 41 165 69 165" stroke="#C2BDB3" strokeWidth="1.5" />
            <path pathLength="1" className={`circuit-route ${pathActive ? 'is-active' : ''}`} d="M0 78H18C45 78 41 165 69 165H100" stroke="#FF5C35" strokeWidth="2" />
            <path pathLength="1" className={`circuit-route circuit-route-delay ${pathActive ? 'is-active' : ''}`} d="M0 252H18C45 252 41 165 69 165" stroke="#FF5C35" strokeWidth="2" />
            {pathActive && <path pathLength="1" className="circuit-packet" d="M0 78H18C45 78 41 165 69 165H100" stroke="#FF5C35" strokeWidth="5" />}
            <circle className={`circuit-junction ${gateActive ? 'is-active' : ''}`} cx="69" cy="165" r="5" fill="#FF5C35" />
          </svg>
          <span className={`absolute left-[43px] top-1/2 -translate-y-1/2 rounded-full border bg-reloop-paper px-2 py-1 brand-data text-[7px] tracking-[0.12em] transition-colors duration-500 ${pathActive ? 'border-reloop-signal text-reloop-signal-hover' : 'border-reloop-line text-reloop-faint'}`}>{gateActive ? 'GUARD' : 'COMPARE'}</span>
        </div>

        <div className="relative z-10">
          <div className="mx-auto flex h-12 w-px flex-col justify-end bg-reloop-line sm:hidden"><span className={`block w-px bg-reloop-signal transition-[height] duration-700 ${pathActive ? 'h-full' : 'h-0'}`} /></div>
          <div className={`circuit-result overflow-hidden rounded-[3px] border bg-reloop-ink text-reloop-paper ${verified ? 'is-verified border-reloop-verified' : 'border-reloop-ink'}`}>
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <Image src="/brand/reloop-symbol-light.svg" alt="" width={42} height={42} />
              <span className="brand-data text-[8px] tracking-[0.14em] text-[#92948d]">CASE RL-2048</span>
            </div>
            <div key={stage} className="animate-brand-reveal p-5 sm:p-6">
              <p className={`brand-data text-[8px] font-semibold tracking-[0.16em] ${verified ? 'text-[#6ed6b4]' : 'text-[#ff7a58]'}`}>{current.eyebrow}</p>
              <h2 className="mt-4 text-2xl font-semibold leading-tight tracking-[-0.04em]">{current.title}</h2>
              <div className="mt-7 space-y-3 border-t border-white/10 pt-5">
                <div className="flex items-center justify-between gap-4 text-xs"><span className="text-[#aeb0a8]">Recommended path</span><span className="text-right font-semibold">{current.pathLabel}</span></div>
                <div className="flex items-center justify-between gap-4 text-xs"><span className="text-[#aeb0a8]">Policy gate</span><span className={`text-right ${gateActive && !verified ? 'text-[#ffd0c3]' : verified ? 'text-[#8ce1c5]' : 'text-[#d0d1cb]'}`}>{current.gateLabel}</span></div>
              </div>
            </div>
            <div className={`flex min-h-[48px] items-center gap-2 px-5 py-4 text-xs font-semibold text-white transition-colors duration-500 ${verified ? 'bg-reloop-verified' : 'bg-reloop-signal'}`}><CheckMark /> {current.footer}</div>
          </div>
        </div>
      </div>

      <div className="mt-8 border-t border-reloop-line pt-5 sm:mt-11">
        <div className="flex items-center justify-between gap-4">
          <div className="grid flex-1 grid-cols-4 gap-1" role="group" aria-label="Recovery sequence stages">
            {stages.map((item, index) => (
              <button
                key={item.short}
                type="button"
                onClick={() => { setStage(index); setPlaying(false); }}
                className={`relative pb-3 text-left brand-data text-[8px] font-semibold tracking-[0.08em] transition-colors ${index === stage ? 'text-reloop-ink' : 'text-reloop-faint hover:text-reloop-muted'}`}
                aria-pressed={index === stage}
              >
                <span className={`absolute inset-x-0 bottom-0 h-px ${index <= stage ? 'bg-reloop-signal' : 'bg-reloop-line'}`} />
                <span className="hidden sm:inline">0{index + 1} / </span>{item.short.toUpperCase()}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setPlaying((value) => !value)} className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-reloop-line bg-reloop-surface text-reloop-muted transition-colors hover:border-reloop-ink hover:text-reloop-ink" aria-label={playing ? 'Pause recovery sequence' : 'Play recovery sequence'}>
            <PauseIcon playing={playing} />
          </button>
        </div>
      </div>
    </div>
  );
}
