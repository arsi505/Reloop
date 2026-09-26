'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

const workflow = [
  {
    name: 'Detect',
    copy: 'Reloop finds conflicting Shopify, ShipStation, or warehouse status.',
    label: 'Mismatch detected',
    title: 'Provider states conflict',
    detail: 'Shopify reports unfulfilled, ShipStation reports in transit, and the warehouse reports shipped.',
  },
  {
    name: 'Review',
    copy: 'The relevant order, shipment, warehouse, and history details are collected in one case.',
    label: 'Evidence ready',
    title: 'The order context is together',
    detail: 'Order, shipment, warehouse, timestamp, and history details are ready to review.',
  },
  {
    name: 'Recover',
    copy: 'Reloop recommends the next action. Sensitive changes can require approval.',
    label: 'Approval required',
    title: 'Recovery is ready for authorization',
    detail: 'The recommended update is scoped to order #10482 and awaits an authorized operator.',
  },
  {
    name: 'Verify',
    copy: 'The connected systems are checked again before the case is resolved.',
    label: 'Case resolved',
    title: 'Provider states are aligned',
    detail: 'Reloop checked the connected systems again and recorded the verified outcome.',
  },
] as const;

function StateContent({ stage }: { stage: number }) {
  if (stage === 0) {
    return (
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-reloop-line bg-white p-4">
          <Image src="/integrations/shopify-logo.svg" alt="Shopify" width={92} height={27} className="h-auto w-[92px]" />
          <div className="mt-5 flex items-center justify-between text-sm"><span className="text-reloop-muted">Order status</span><strong>Unfulfilled</strong></div>
        </div>
        <div className="rounded-lg border border-reloop-line bg-white p-4">
          <p className="flex min-h-[27px] items-center text-sm font-semibold">Warehouse / 3PL</p>
          <div className="mt-5 flex items-center justify-between text-sm"><span className="text-reloop-muted">Warehouse status</span><strong>Shipped</strong></div>
        </div>
        <div className="rounded-lg border border-reloop-line bg-white p-4">
          <Image src="/integrations/shipstation-logo.svg" alt="ShipStation" width={126} height={20} style={{ width: '126px', height: 'auto' }} />
          <div className="mt-5 flex items-center justify-between text-sm"><span className="text-reloop-muted">Shipment status</span><strong>In transit</strong></div>
        </div>
      </div>
    );
  }

  if (stage === 1) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-reloop-line bg-white p-4"><p className="text-xs text-reloop-muted">Provider evidence</p><p className="mt-2 text-sm font-semibold">Conflicting system states attached</p></div>
        <div className="rounded-lg border border-reloop-line bg-white p-4"><p className="text-xs text-reloop-muted">Relevant history</p><p className="mt-2 text-sm font-semibold">Shipment updated at 10:42 UTC</p></div>
        <div className="rounded-lg border border-reloop-line bg-white p-4"><p className="text-xs text-reloop-muted">Order context</p><p className="mt-2 text-sm font-semibold">Order #10482 · Shopify</p></div>
        <div className="rounded-lg border border-reloop-line bg-white p-4"><p className="text-xs text-reloop-muted">Case history</p><p className="mt-2 text-sm font-semibold">Mismatch opened at 10:43 UTC</p></div>
      </div>
    );
  }

  if (stage === 2) {
    return (
      <div className="rounded-lg border border-[#f0c2b7] bg-[#fff7f4] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm font-semibold">Recommended recovery</p><span className="rounded-full bg-[#ffe7df] px-3 py-1 text-xs font-semibold text-reloop-signal-hover">Approval required</span></div>
        <p className="mt-4 text-lg font-semibold">Review the order fulfillment state</p>
        <div className="mt-5 flex items-center justify-between border-t border-black/10 pt-4 text-sm"><span className="text-reloop-muted">Authorized action</span><span className="font-semibold">Order #10482 only</span></div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[#a9ddca] bg-[#effaf5] p-5">
      <div className="flex items-center gap-3"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-reloop-verified text-white">✓</span><div><p className="text-sm font-semibold text-reloop-verified">Verification complete</p><p className="mt-0.5 text-xs text-reloop-muted">Case RL-2048 resolved</p></div></div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-md bg-white/75 p-3 text-sm"><span className="text-reloop-muted">Shopify</span><strong className="float-right">Fulfilled</strong></div>
        <div className="rounded-md bg-white/75 p-3 text-sm"><span className="text-reloop-muted">ShipStation</span><strong className="float-right">In transit</strong></div>
        <div className="rounded-md bg-white/75 p-3 text-sm"><span className="text-reloop-muted">Warehouse</span><strong className="float-right">Shipped</strong></div>
      </div>
    </div>
  );
}

export function RecoveryWorkflow() {
  const [stage, setStage] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setPlaying(false);
      setStage(3);
    }
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !('IntersectionObserver' in window)) {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.3 });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    if (!playing || !inView || !pageVisible) return;
    const delay = stage === 3 ? 4200 : 2700;
    const timer = window.setTimeout(() => setStage((current) => (current + 1) % workflow.length), delay);
    return () => window.clearTimeout(timer);
  }, [inView, pageVisible, playing, stage]);

  const selectStage = (index: number) => {
    setStage(index);
    setPlaying(false);
  };

  return (
    <div ref={rootRef} className="mt-9">
      <div className="relative hidden lg:block">
        <div className="absolute left-[12.5%] right-[12.5%] top-5 h-px bg-reloop-line" />
        <div className="absolute left-[12.5%] top-5 h-px bg-reloop-signal transition-[width] duration-700 ease-brand" style={{ width: `${stage * 25}%` }} />
        <span className="absolute top-[17px] h-2 w-2 -translate-x-1/2 rounded-full bg-reloop-signal shadow-[0_0_0_5px_rgba(255,92,53,0.12)] transition-[left] duration-700 ease-brand" style={{ left: `${12.5 + stage * 25}%` }} />
        <div className="relative grid grid-cols-4">
          {workflow.map((item, index) => (
            <button key={item.name} type="button" aria-pressed={stage === index} onClick={() => selectStage(index)} className="group relative min-h-32 px-5 pt-12 text-left">
              <span className={`absolute top-0 flex h-10 w-10 items-center justify-center rounded-full border text-sm font-semibold transition-colors duration-300 ${index <= stage ? 'border-reloop-signal bg-reloop-signal text-white' : 'border-reloop-line bg-reloop-paper text-reloop-muted'}`}>{index + 1}</span>
              <span className={`text-xl font-semibold tracking-[-0.03em] transition-colors ${stage === index ? 'text-reloop-ink' : 'text-reloop-muted'}`}>{item.name}</span>
              <span className="mt-3 block max-w-[245px] text-sm leading-6 text-reloop-muted">{item.copy}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1 lg:hidden" role="group" aria-label="Recovery workflow stages">
        {workflow.map((item, index) => (
          <button key={item.name} type="button" aria-pressed={stage === index} onClick={() => selectStage(index)} className="relative flex min-h-[72px] w-full gap-4 text-left">
            <span className="relative flex w-8 shrink-0 justify-center"><span className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold ${index <= stage ? 'border-reloop-signal bg-reloop-signal text-white' : 'border-reloop-line bg-reloop-paper text-reloop-muted'}`}>{index + 1}</span>{index < workflow.length - 1 && <span className={`absolute bottom-0 top-8 w-px ${index < stage ? 'bg-reloop-signal' : 'bg-reloop-line'}`} />}</span>
            <span className="pb-5"><span className="block text-lg font-semibold">{item.name}</span><span className="mt-1 block text-sm leading-6 text-reloop-muted">{item.copy}</span></span>
          </button>
        ))}
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-reloop-line bg-[#f8f7f3] shadow-subtle lg:mt-6">
        <div className="flex items-center justify-between border-b border-reloop-line bg-white px-5 py-4"><div className="flex items-center gap-3"><Image src="/brand/reloop-symbol.svg" alt="" width={25} height={25} /><span className="text-sm font-semibold">Order #10482</span></div><span className={`text-xs font-semibold ${stage === 3 ? 'text-reloop-verified' : 'text-reloop-signal-hover'}`}>{workflow[stage].label}</span></div>
        <div key={stage} className="workflow-state grid gap-5 p-5 sm:p-6 lg:grid-cols-[0.7fr_1.3fr] lg:items-center lg:p-6">
          <div><p className="text-sm font-semibold text-reloop-signal-hover">{workflow[stage].name}</p><h3 className="mt-2 text-2xl font-semibold tracking-[-0.04em]">{workflow[stage].title}</h3><p className="mt-3 max-w-md text-sm leading-6 text-reloop-muted">{workflow[stage].detail}</p></div>
          <StateContent stage={stage} />
        </div>
      </div>
    </div>
  );
}
