import Image from 'next/image';

type BrandLockupProps = {
  tone?: 'dark' | 'light';
  size?: 'compact' | 'default' | 'large';
  className?: string;
  priority?: boolean;
};

const sizes = {
  compact: {
    symbol: 34,
    word: 'text-[22px]',
    descriptor: 'text-[9px] tracking-[0.11em]',
    gap: 'gap-2.5',
  },
  default: {
    symbol: 42,
    word: 'text-[28px]',
    descriptor: 'text-[9px] tracking-[0.12em]',
    gap: 'gap-3',
  },
  large: {
    symbol: 50,
    word: 'text-[33px]',
    descriptor: 'text-[10px] tracking-[0.12em]',
    gap: 'gap-3.5',
  },
};

export function BrandLockup({ tone = 'dark', size = 'default', className = '', priority = false }: BrandLockupProps) {
  const scale = sizes[size];
  const light = tone === 'light';

  return (
    <span className={`inline-flex items-center ${scale.gap} ${className}`} aria-label="Reloop Reliability Engine">
      <Image
        src={light ? '/brand/reloop-symbol-light.svg' : '/brand/reloop-symbol.svg'}
        alt=""
        width={scale.symbol}
        height={scale.symbol}
        priority={priority}
        className="shrink-0"
      />
      <span className="flex flex-col">
        <span className={`font-display font-[680] leading-[0.88] tracking-[-0.055em] ${scale.word} ${light ? 'text-reloop-paper' : 'text-reloop-ink'}`}>Reloop</span>
        <span className={`mt-1.5 whitespace-nowrap font-data font-semibold leading-none ${scale.descriptor} ${light ? 'text-[#9fa198]' : 'text-reloop-muted'}`}>RELIABILITY ENGINE</span>
      </span>
    </span>
  );
}
