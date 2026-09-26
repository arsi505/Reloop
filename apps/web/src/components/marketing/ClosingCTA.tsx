import Link from 'next/link';
import { BrandLockup } from '../brand/BrandLockup';

const footerGroups = [
  {
    title: 'Product',
    links: [
      ['Product', '#product'],
      ['How it works', '#how-it-works'],
      ['Integrations', '#integrations'],
      ['Pricing', '#pricing'],
    ],
  },
  {
    title: 'Workspace',
    links: [
      ['Dashboard', '/dashboard'],
      ['Exceptions', '/exceptions'],
      ['Recoveries', '/recoveries'],
    ],
  },
  {
    title: 'Access',
    links: [
      ['Create workspace', '/register'],
      ['Sign in', '/login'],
    ],
  },
];

export function ClosingCTA() {
  return (
    <footer className="border-t border-white/10 bg-reloop-ink text-reloop-paper">
      <div className="mx-auto max-w-[1280px] px-5 py-9 sm:px-8 sm:py-10 lg:px-12">
        <div className="grid gap-10 border-b border-white/10 pb-9 lg:grid-cols-[1fr_1.3fr] lg:gap-16">
          <div>
            <Link href="/" aria-label="Reloop homepage" className="inline-block"><BrandLockup tone="light" size="large" /></Link>
            <p className="mt-6 max-w-md text-base leading-7 text-[#adafa7]">Reloop helps commerce teams detect and resolve mismatches between Shopify, ShipStation, and warehouse / 3PL operations.</p>
          </div>

          <nav aria-label="Footer navigation" className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3">
            {footerGroups.map((group) => (
              <div key={group.title}>
                <p className="text-sm font-semibold text-white">{group.title}</p>
                <ul className="mt-5 space-y-3.5">
                  {group.links.map(([label, href]) => <li key={label}><Link href={href} className="text-sm text-[#adafa7] transition-colors hover:text-white">{label}</Link></li>)}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div className="flex flex-col gap-2 pt-6 text-xs text-[#7f8179] sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 Reloop</p>
          <p>Order reliability for commerce teams.</p>
        </div>
      </div>
    </footer>
  );
}
