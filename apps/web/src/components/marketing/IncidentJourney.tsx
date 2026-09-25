'use client';

import Image from 'next/image';
import { type KeyboardEvent, useRef, useState } from 'react';
import { SectionIndex } from '../brand/SectionIndex';

const moments = [
  {
    number: '01',
    label: 'Detect',
    time: '10:42:08',
    eyebrow: 'EXCEPTION CREATED',
    title: 'Provider states no longer agree.',
    copy: 'Reloop compares normalized order and shipment state, then opens one case with the conflicting evidence already attached.',
    owner: 'Reloop monitor',
    state: 'Investigating',
    tone: 'signal',
    records: [
      ['Shopify', 'Fulfillment', 'Unfulfilled'],
      ['ShipStation', 'Shipment', 'In transit'],
      ['Rule', 'State parity', 'Failed'],
    ],
  },
  {
    number: '02',
    label: 'Investigate',
    time: '10:42:12',
    eyebrow: 'EVIDENCE CORRELATED',
    title: 'The likely recovery path is identified.',
    copy: 'The case links the shipment, order, and provider timestamps so an operator can see what changed without rebuilding the sequence manually.',
    owner: 'Evidence engine',
    state: 'Path found',
    tone: 'info',
    records: [
      ['Tracking', 'Carrier scan', 'Confirmed'],
      ['Order', 'Customer impact', 'Visible'],
      ['Action', 'Recommended', 'Mark fulfilled'],
    ],
  },
  {
    number: '03',
    label: 'Approve',
    time: '10:44:31',
    eyebrow: 'HUMAN GATE',
    title: 'Automation pauses for judgment.',
    copy: 'Because the proposed action changes the customer-visible order state, policy requires an authorized operator to approve the exact mutation.',
    owner: 'Maya Chen · Ops lead',
    state: 'Approved',
    tone: 'warning',
    records: [
      ['Policy', 'Customer state change', 'Protected'],
      ['Decision', 'Operator approval', 'Recorded'],
      ['Scope', 'Order RL-2048', 'Only'],
    ],
  },
  {
    number: '04',
    label: 'Recover',
    time: '10:44:33',
    eyebrow: 'CONTROLLED WRITE',
    title: 'The bounded correction is executed.',
    copy: 'Reloop applies the approved change with the original evidence, policy decision, and action scope carried into the execution record.',
    owner: 'Recovery workflow',
    state: 'Executed',
    tone: 'signal',
    records: [
      ['Mutation', 'Fulfillment update', 'Accepted'],
      ['Provider', 'Shopify response', '200 OK'],
      ['Scope', 'Additional orders', 'None'],
    ],
  },
  {
    number: '05',
    label: 'Verify',
    time: '10:44:35',
    eyebrow: 'LOOP CLOSED',
    title: 'The source systems confirm the outcome.',
    copy: 'Reloop reads the provider state again before resolving the exception. The complete sequence remains available as one operational record.',
    owner: 'Verification engine',
    state: 'Resolved',
    tone: 'verified',
    records: [
      ['Shopify', 'Fulfillment', 'Fulfilled'],
      ['ShipStation', 'Shipment', 'In transit'],
      ['Evidence', 'Operational record', 'Complete'],
    ],
  },
] as const;

const toneStyles = {
  signal: { dot: 'bg-reloop-signal', text: 'text-[#ff8162]', border: 'border-reloop-signal/35' },
  info: { dot: 'bg-[#6ca2ba]', text: 'text-[#8fc3d7]', border: 'border-[#6ca2ba]/35' },
  warning: { dot: 'bg-[#d69732]', text: 'text-[#efbd6e]', border: 'border-[#d69732]/35' },
  verified: { dot: 'bg-reloop-verified', text: 'text-[#72d4b4]', border: 'border-reloop-verified/40' },
};

function ArrowIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 7H11M8 4L11 7L8 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function IncidentJourney() {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const moment = moments[active];
  const tone = toneStyles[moment.tone];

  const selectTab = (index: number) => {
    const next = (index + moments.length) % moments.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      selectTab(index + 1);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      selectTab(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      selectTab(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      selectTab(moments.length - 1);
    }
  };

  return (
    <section id="incident-journey" className="border-t border-white/10 bg-reloop-ink text-reloop-paper">
      <div className="mx-auto max-w-[1440px] px-5 py-20 sm:px-10 lg:px-12 lg:py-28">
        <div data-reveal="up" className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_430px] lg:items-start lg:gap-20">
          <div className="lg:pt-2">
            <SectionIndex number="03" label="CASE RECORD" tone="light" note="ONE INCIDENT / END TO END" />
            <h2 className="brand-display brand-section-title mt-6">From drift to proof.</h2>
          </div>
          <div className="border-y border-white/15">
            <div className="flex items-center justify-between border-b border-white/10 py-4 brand-data text-[9px] tracking-[0.13em]"><span className="text-[#777970]">CASE ABSTRACT / RL-2048</span><span className="text-[#72d4b4]">VERIFIED</span></div>
            <div className="grid grid-cols-3 gap-px bg-white/10">
              {[
                ['02:27', 'elapsed'],
                ['01', 'approval'],
                ['05', 'events'],
              ].map(([value, label]) => <div key={label} className="bg-reloop-ink py-5"><p className="font-display text-2xl font-semibold tracking-[-0.04em]">{value}</p><p className="mt-1 brand-data text-[8px] uppercase tracking-[0.12em] text-[#71736c]">{label}</p></div>)}
            </div>
            <p className="py-5 text-[15px] leading-7 text-[#a9aba4]">Every exception becomes one durable case. Context, operator judgment, and verification travel together instead of being reconstructed after the fact.</p>
          </div>
        </div>

        <div data-reveal="scale" className="mt-16 border-y border-white/15 lg:mt-20">
          <div className="grid lg:grid-cols-[0.46fr_1.54fr]">
            <div className="border-b border-white/15 lg:border-b-0 lg:border-r">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-5 sm:px-7">
                <span className="brand-data text-[9px] font-semibold tracking-[0.15em] text-[#7f8179]">CASE RL-2048</span>
                <span className="flex items-center gap-2 brand-data text-[8px] tracking-[0.13em] text-[#72d4b4]"><span className="h-1.5 w-1.5 rounded-full bg-reloop-verified" /> COMPLETE</span>
              </div>
              <div role="tablist" aria-label="Incident journey stages">
                {moments.map((item, index) => {
                  const selected = active === index;
                  const completed = index < active;
                  return (
                    <button
                      key={item.label}
                      id={`incident-tab-${index}`}
                      ref={(element) => { tabRefs.current[index] = element; }}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-controls="incident-stage-panel"
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setActive(index)}
                      onKeyDown={(event) => handleTabKeyDown(event, index)}
                      className={`group relative flex w-full items-center gap-4 border-b border-white/10 px-5 py-5 text-left transition-colors sm:px-7 ${selected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.035]'}`}
                    >
                      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border brand-data text-[8px] transition-colors ${selected ? `${tone.border} ${tone.text}` : completed ? 'border-reloop-verified/35 text-[#72d4b4]' : 'border-white/15 text-[#696b64]'}`}>{completed ? '✓' : item.number}</span>
                      <span className="min-w-0 flex-1"><span className={`block text-sm font-semibold transition-colors ${selected ? 'text-white' : 'text-[#aaaCA5]'}`}>{item.label}</span><span className="mt-1 block brand-data text-[8px] tracking-[0.1em] text-[#676961]">{item.time}</span></span>
                      <span className={`transition-transform ${selected ? 'translate-x-0 text-white' : '-translate-x-1 text-[#565850] group-hover:translate-x-0'}`}><ArrowIcon /></span>
                      {selected && <span className={`absolute inset-y-0 left-0 w-[3px] ${tone.dot}`} />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div id="incident-stage-panel" role="tabpanel" aria-labelledby={`incident-tab-${active}`} className="relative min-h-[650px] overflow-hidden bg-[#151611] p-5 sm:p-8 lg:p-10">
              <svg className="pointer-events-none absolute right-0 top-0 h-full w-[60%] opacity-[0.07]" viewBox="0 0 600 700" fill="none" aria-hidden="true"><circle cx="500" cy="70" r="210" stroke="white"/><circle cx="500" cy="70" r="290" stroke="white"/><path d="M0 500C180 500 190 280 380 280H620" stroke="white"/><path d="M0 580C180 580 190 360 380 360H620" stroke="white"/></svg>

              <div key={active} className="relative animate-brand-reveal">
                <div className="flex flex-col gap-6 border-b border-white/10 pb-8 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className={`brand-data text-[9px] font-semibold tracking-[0.18em] ${tone.text}`}>{moment.eyebrow}</p>
                    <h3 className="mt-5 max-w-2xl text-4xl font-semibold leading-[1.02] tracking-[-0.055em] sm:text-5xl">{moment.title}</h3>
                  </div>
                  <div className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 brand-data text-[8px] font-semibold tracking-[0.12em] ${tone.border} ${tone.text}`}><span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />{moment.state.toUpperCase()}</div>
                </div>

                <div className="grid gap-8 py-8 lg:grid-cols-[1fr_0.72fr]">
                  <p className="max-w-xl text-[16px] leading-8 text-[#b8bab2]">{moment.copy}</p>
                  <div className="lg:text-right"><p className="brand-data text-[8px] tracking-[0.14em] text-[#696b64]">ACTOR / OWNER</p><p className="mt-2 text-sm font-semibold">{moment.owner}</p></div>
                </div>

                <div className="overflow-hidden border-y border-white/12 bg-[#11120e]">
                  <div className="flex items-center justify-between border-b border-white/10 px-5 py-4"><span className="brand-data text-[8px] font-semibold tracking-[0.15em] text-[#7d7f77]">EVIDENCE SNAPSHOT</span><span className="brand-data text-[8px] text-[#61635c]">{moment.time} UTC</span></div>
                  <div>
                    {moment.records.map(([source, label, value], index) => (
                      <div key={source + label} className="grid grid-cols-[0.7fr_1fr] gap-4 border-b border-white/10 px-5 py-4 last:border-b-0 sm:grid-cols-[0.7fr_1fr_0.75fr] sm:items-center">
                        <div className="flex items-center gap-3"><span className={`h-1.5 w-1.5 rounded-full ${index === 2 ? tone.dot : 'bg-[#676961]'}`} /><span className="text-xs font-semibold">{source}</span></div>
                        <span className="brand-data text-[8px] tracking-[0.1em] text-[#74766f]">{label.toUpperCase()}</span>
                        <span className={`col-span-2 text-sm font-semibold sm:col-span-1 sm:text-right ${index === 2 ? tone.text : 'text-[#d7d8d2]'}`}>{value}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-7 flex flex-col gap-4 border-t border-white/10 pt-6 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3"><Image src="/brand/reloop-symbol-light.svg" alt="" width={34} height={34} /><span className="brand-data text-[8px] tracking-[0.12em] text-[#75776f]">EVIDENCE APPENDED TO CASE</span></div>
                  <button type="button" onClick={() => setActive((active + 1) % moments.length)} className="inline-flex items-center justify-center gap-2 rounded-[10px] border border-white/15 px-4 py-3 text-xs font-semibold transition-colors hover:border-white/30 hover:bg-white/[0.05]">{active === moments.length - 1 ? 'Replay incident' : `Continue to ${moments[active + 1].label}`} <ArrowIcon /></button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div data-reveal="soft" className="grid gap-px bg-white/10 sm:grid-cols-3">
          {[
            ['01', 'Context travels', 'Evidence stays attached as the incident changes hands.'],
            ['02', 'Judgment is explicit', 'Operator decisions are recorded at the point of action.'],
            ['03', 'Resolution is proven', 'A successful write is not enough; source state is checked again.'],
          ].map(([number, title, copy]) => <div key={number} className="bg-reloop-ink px-5 py-7 sm:px-7"><p className="brand-data text-[8px] text-[#676961]">{number}</p><h3 className="mt-5 text-lg font-semibold tracking-[-0.03em]">{title}</h3><p className="mt-2 text-sm leading-6 text-[#898b83]">{copy}</p></div>)}
        </div>
      </div>
    </section>
  );
}
