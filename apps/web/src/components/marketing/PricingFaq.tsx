'use client';

import Link from 'next/link';
import { useState } from 'react';

const planFeatures = [
  '1 workspace',
  'Shopify order monitoring',
  'ShipStation shipment monitoring',
  'Warehouse / 3PL status',
  'Mismatch detection',
  'Exception cases',
  'Evidence and case history',
  'Human approval workflow',
  'Recovery tracking',
  'Verification before resolution',
];

const faqs = [
  {
    question: 'What does Reloop do?',
    answer: (
      <>
        <p>Reloop monitors Shopify orders, ShipStation shipments, and warehouse / 3PL status.</p>
        <p>When those systems disagree, Reloop creates a case with the relevant details so your team can review and resolve the issue.</p>
      </>
    ),
  },
  {
    question: 'What systems does Reloop work with?',
    answer: (
      <>
        <p>Reloop is currently focused on Shopify, ShipStation, and warehouse / 3PL workflows.</p>
        <p>We are keeping the product focused before adding more platforms.</p>
      </>
    ),
  },
  {
    question: 'What happens when the systems disagree?',
    answer: <p>Reloop creates a case showing the conflicting order, shipment, and warehouse information so your team can review what happened and decide the next step.</p>,
  },
  {
    question: 'Does Reloop make changes automatically?',
    answer: (
      <>
        <p>Reloop can prepare and coordinate recovery actions, but sensitive actions can require approval before anything is changed.</p>
        <p>Reloop checks the connected systems again before a case is considered resolved.</p>
      </>
    ),
  },
  {
    question: 'Who is Reloop for?',
    answer: <p>Reloop is designed for small commerce teams using Shopify, ShipStation, and a warehouse or 3PL that need a clearer way to handle order-state mismatches.</p>,
  },
  {
    question: 'How much does Reloop cost?',
    answer: <p>The Founding Plan is $9 per month.</p>,
  },
];

function ArrowUpRight() {
  return <svg className="brand-button-icon" width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="M4 11L11 4M5 4H11V10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function CheckIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.2L6.25 11.25L13 4.75" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function PricingFaq() {
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  return (
    <>
      <section id="pricing" className="border-t border-reloop-line bg-reloop-paper">
        <div className="mx-auto max-w-[1280px] px-5 py-14 sm:px-8 sm:py-16 lg:px-12">
          <div data-reveal="up" className="grid gap-7 lg:grid-cols-[1fr_0.72fr] lg:items-end lg:gap-16">
            <div>
              <p className="text-sm font-semibold text-reloop-signal-hover">Pricing</p>
              <h2 className="brand-display mt-5 max-w-4xl text-[clamp(2.65rem,4.1vw,4rem)] leading-[0.95] tracking-[-0.055em]">Simple pricing for a focused operations tool.</h2>
            </div>
            <p className="max-w-xl text-lg leading-8 text-reloop-muted">Start with the core Reloop workflow for Shopify, ShipStation, and warehouse / 3PL operations.</p>
          </div>

          <div data-reveal="soft" className="mt-9 overflow-hidden rounded-xl border border-reloop-line-strong bg-reloop-canvas shadow-[0_20px_60px_rgba(36,31,24,0.08)] lg:grid lg:grid-cols-[0.78fr_1.22fr]">
            <div className="border-b border-reloop-line p-6 sm:p-8 lg:border-b-0 lg:border-r lg:p-10">
              <p className="text-sm font-semibold text-reloop-signal-hover">Founding Plan</p>
              <div className="mt-6 flex items-end gap-2"><span className="brand-display text-[clamp(4rem,7vw,6rem)] leading-none tracking-[-0.06em]">$9</span><span className="pb-2 text-base text-reloop-muted">/ month</span></div>
              <p className="mt-6 max-w-md text-base leading-7 text-reloop-muted">For small commerce teams using Shopify, ShipStation, and a warehouse or 3PL.</p>
              <Link href="/register" className="brand-button brand-button-primary mt-8 min-h-[50px] w-full px-6 sm:w-auto">Start with Reloop <ArrowUpRight /></Link>
              <p className="mt-4 text-sm text-reloop-faint">Founding pricing for early Reloop users.</p>
            </div>

            <div className="p-6 sm:p-8 lg:p-10">
              <p className="text-sm font-semibold">Everything in the focused workflow</p>
              <ul className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2">
                {planFeatures.map((feature) => (
                  <li key={feature} className="flex items-start gap-3 text-sm leading-6 text-reloop-muted">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#e9f7f1] text-reloop-verified"><CheckIcon /></span>
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section id="faq" className="border-t border-reloop-line bg-reloop-canvas">
        <div className="mx-auto grid max-w-[1280px] gap-9 px-5 py-14 sm:px-8 sm:py-16 lg:grid-cols-[0.64fr_1fr] lg:gap-20 lg:px-12">
          <div data-reveal="up">
            <p className="text-sm font-semibold text-reloop-signal-hover">FAQ</p>
            <h2 className="brand-display mt-5 text-[clamp(2.65rem,4.1vw,4rem)] leading-[0.95] tracking-[-0.055em]">Questions about Reloop</h2>
          </div>

          <div data-reveal="soft" className="border-t border-reloop-line-strong">
            {faqs.map((faq, index) => {
              const expanded = openFaq === index;
              const panelId = `faq-panel-${index + 1}`;
              const buttonId = `faq-button-${index + 1}`;
              return (
                <div key={faq.question} className="border-b border-reloop-line-strong">
                  <button
                    id={buttonId}
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    onClick={() => setOpenFaq(expanded ? null : index)}
                    className="group flex min-h-[68px] w-full items-center justify-between gap-5 py-4 text-left text-base font-semibold outline-none transition-colors hover:text-reloop-signal-hover focus-visible:ring-2 focus-visible:ring-reloop-signal focus-visible:ring-offset-2 sm:text-lg"
                  >
                    <span>{faq.question}</span>
                    <span className="relative h-8 w-8 shrink-0 rounded-full border border-reloop-line bg-reloop-paper" aria-hidden="true">
                      <span className="absolute left-1/2 top-1/2 h-px w-3.5 -translate-x-1/2 -translate-y-1/2 bg-current" />
                      <span className={`absolute left-1/2 top-1/2 h-3.5 w-px -translate-x-1/2 -translate-y-1/2 bg-current transition-transform duration-300 ${expanded ? 'rotate-90 opacity-0' : ''}`} />
                    </span>
                  </button>
                  <div id={panelId} role="region" aria-labelledby={buttonId} aria-hidden={!expanded} className={`grid transition-[grid-template-rows,opacity] duration-300 ease-brand ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                    <div className="overflow-hidden">
                      <div className="max-w-2xl space-y-3 pb-6 pr-12 text-sm leading-7 text-reloop-muted sm:text-base">{faq.answer}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="bg-reloop-canvas px-5 pb-14 sm:px-8 sm:pb-16 lg:px-12">
        <div data-reveal="up" className="mx-auto max-w-[1184px] overflow-hidden rounded-xl bg-reloop-ink px-6 py-9 text-reloop-paper sm:px-10 sm:py-10 lg:flex lg:items-end lg:justify-between lg:gap-16 lg:px-12">
          <div className="max-w-3xl">
            <h2 className="brand-display text-[clamp(2.6rem,4.2vw,4rem)] leading-[0.96] tracking-[-0.055em]">Resolve order mismatches without jumping between systems.</h2>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-[#b8bab2]">Give your operations team one place to review the issue, approve the next step, and verify the result.</p>
          </div>
          <div className="mt-9 flex shrink-0 flex-col gap-3 sm:flex-row lg:mt-0 lg:flex-col">
            <Link href="/register" className="brand-button brand-button-primary min-h-[50px] px-6">Create workspace <ArrowUpRight /></Link>
            <Link href="/login" className="brand-button min-h-[50px] border border-white/25 px-6 text-reloop-paper hover:border-white/60 hover:bg-white/[0.06]">Sign in</Link>
          </div>
        </div>
      </section>
    </>
  );
}
