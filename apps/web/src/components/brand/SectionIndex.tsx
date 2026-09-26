type SectionIndexProps = {
  number: string;
  label: string;
  tone?: 'dark' | 'light';
  note?: string;
};

export function SectionIndex({ number, label, tone = 'dark', note }: SectionIndexProps) {
  const muted = tone === 'light' ? 'text-[#777970]' : 'text-reloop-faint';
  const rule = tone === 'light' ? 'border-white/12' : 'border-reloop-line';

  return (
    <div className={`grid grid-cols-[42px_auto_1fr] items-center gap-3 border-b pb-4 ${rule}`}>
      <svg viewBox="0 0 42 22" width="42" height="22" fill="none" aria-hidden="true">
        <path d="M3 4H12C17 4 17 11 22 11H38" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" className={tone === 'light' ? 'text-[#9a9c94]' : 'text-reloop-muted'} />
        <path d="M3 18H12C17 18 17 11 22 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" className={tone === 'light' ? 'text-[#9a9c94]' : 'text-reloop-muted'} />
        <rect x="1" y="2" width="4" height="4" fill="#FF5C35" />
        <rect x="1" y="16" width="4" height="4" fill="#FF5C35" />
        <rect x="35" y="8" width="7" height="7" fill="#FF5C35" />
      </svg>
      <p className="brand-data text-[11px] font-semibold tracking-[0.1em] text-reloop-signal sm:text-xs">{number} / {label}</p>
      <div className={`flex items-center justify-end gap-3 ${muted}`}>
        <span className={`hidden h-px flex-1 border-t ${rule} sm:block`} />
        {note && <span className="hidden whitespace-nowrap brand-data text-[11px] tracking-[0.06em] lg:block">{note}</span>}
      </div>
    </div>
  );
}

export function EvidenceStamp() {
  return (
    <div className="inline-grid grid-cols-[auto_1fr] border border-black/35 bg-black/[0.04] brand-data text-[11px] font-semibold tracking-[0.06em]">
      <span className="border-r border-black/25 px-3 py-2">RL / 2048</span>
      <span className="px-3 py-2">VERIFIED · 10:44:35 UTC</span>
    </div>
  );
}
