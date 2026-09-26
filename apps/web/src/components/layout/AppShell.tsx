'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/auth-context';
import { useRealtimeStatus } from '../../context/realtime-context';
import { BrandLockup } from '../brand/BrandLockup';
import {
  DashboardIcon, ExceptionsIcon, OrdersIcon, RecoveriesIcon, IntegrationsIcon,
  HealthIcon, RulesIcon, AnalyticsIcon, SettingsIcon, SearchIcon, BellIcon,
  ChevronDownIcon, XIcon,
} from '../icons/Icons';

export type NavTab = 'dashboard' | 'exceptions' | 'orders' | 'recoveries' | 'integrations' | 'health' | 'rules' | 'analytics' | 'settings';

interface AppShellProps {
  children: React.ReactNode;
  activeTab: NavTab;
  openExceptionsCount?: number;
}

type NavigationItem = {
  id: NavTab;
  label: string;
  href: string;
  code: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  badge?: number;
};

const pageLabels: Record<NavTab, string> = {
  dashboard: 'Operations overview', exceptions: 'Exception queue', orders: 'Order records',
  recoveries: 'Recovery cases', integrations: 'Connected systems', health: 'System health',
  rules: 'Rules & logic', analytics: 'Analytics', settings: 'Settings',
};

export function AppShell({ children, activeTab, openExceptionsCount = 0 }: AppShellProps) {
  const { user, organization, role, logout } = useAuth();
  const realtimeStatus = useRealtimeStatus();
  const router = useRouter();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [infoModal, setInfoModal] = useState<{ title: string; desc: string } | null>(null);

  const initials = user?.name
    ? user.name.split(' ').map((name) => name[0]).join('').slice(0, 2).toUpperCase()
    : 'OP';

  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (searchQuery.trim()) router.push(`/exceptions?search=${encodeURIComponent(searchQuery.trim())}`);
  };

  const navItems: NavigationItem[] = [
    { id: 'dashboard', label: 'Overview', href: '/dashboard', code: '01', icon: DashboardIcon },
    { id: 'exceptions', label: 'Exceptions', href: '/exceptions', code: '02', icon: ExceptionsIcon, badge: openExceptionsCount || undefined },
    { id: 'orders', label: 'Orders', href: '/orders', code: '03', icon: OrdersIcon },
    { id: 'recoveries', label: 'Recoveries', href: '/recoveries', code: '04', icon: RecoveriesIcon },
    { id: 'integrations', label: 'Integrations', href: '/integrations', code: '05', icon: IntegrationsIcon },
    { id: 'health', label: 'System health', href: '/health', code: '06', icon: HealthIcon },
  ];

  const secondaryNavItems = [
    { id: 'rules' as const, label: 'Rules & logic', badge: 'POLICY', description: 'Automated reconciliation rules and match tolerances are provisioned through organization policy contracts.', icon: RulesIcon },
    { id: 'analytics' as const, label: 'Analytics', badge: 'SOON', description: 'Historical recovery trends, prevented refund cost, and SLA metrics are in the upcoming release.', icon: AnalyticsIcon },
    { id: 'settings' as const, label: 'Settings', badge: 'ADMIN', description: 'Organization security, SSO, and team roles are managed through authenticated administration APIs.', icon: SettingsIcon },
  ];

  const closeMobileNavigation = () => setMobileMenuOpen(false);

  const sidebarContent = (
    <div className="relative flex h-full flex-col bg-reloop-ink text-reloop-paper">
      <div className="pointer-events-none absolute inset-0 opacity-[0.035] brand-grid" />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="border-b border-white/10 px-6 py-6">
          <Link href="/dashboard" aria-label="Reloop operations overview"><BrandLockup tone="light" size="default" priority /></Link>
        </div>

        <div className="px-4 py-4">
          <button type="button" className="flex w-full items-center justify-between border border-white/10 bg-white/[0.035] px-3.5 py-3 text-left transition-colors hover:bg-white/[0.06]">
            <span className="flex min-w-0 items-center gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center bg-reloop-signal text-xs font-bold text-white">{organization?.name?.charAt(0).toUpperCase() || 'O'}</span>
              <span className="min-w-0">
                <span className="brand-data block text-[10px] tracking-[0.07em] text-[#9a9c94]">ACTIVE WORKSPACE</span>
                <span className="mt-1 block truncate text-xs font-semibold text-reloop-paper">{organization?.name || 'My Organization'}</span>
              </span>
            </span>
            <ChevronDownIcon size={12} className="shrink-0 text-[#777970]" />
          </button>
        </div>

        <nav className="px-4 pb-4" aria-label="Operations">
          <p className="brand-data px-3 pb-2 pt-1 text-[10px] font-semibold tracking-[0.09em] text-[#8f9189]">OPERATIONS</p>
          <div className="space-y-1">
            {navItems.map((item) => {
              const active = activeTab === item.id;
              const Icon = item.icon;
              return (
                <Link key={item.id} href={item.href} onClick={closeMobileNavigation} className={`group relative flex min-h-10 items-center justify-between px-3 text-sm transition-colors ${active ? 'bg-white/[0.08] text-white' : 'text-[#b8bab2] hover:bg-white/[0.045] hover:text-white'}`}>
                  {active && <span className="absolute inset-y-0 left-0 w-[3px] bg-reloop-signal" />}
                  <span className="flex items-center gap-3">
                    <span className={`brand-data w-4 text-[10px] ${active ? 'text-reloop-signal' : 'text-[#777970]'}`}>{item.code}</span>
                    <Icon size={15} className={active ? 'text-reloop-paper' : 'text-[#777970] group-hover:text-reloop-paper'} />
                    <span className="font-medium">{item.label}</span>
                  </span>
                  {item.badge !== undefined && <span className="brand-data min-w-5 bg-reloop-signal px-1.5 py-0.5 text-center text-[10px] font-semibold text-white">{item.badge}</span>}
                </Link>
              );
            })}
          </div>
        </nav>

        <div className="mx-4 border-t border-white/10" />

        <nav className="px-4 py-4" aria-label="Configuration">
          <p className="brand-data px-3 pb-2 pt-1 text-[10px] font-semibold tracking-[0.09em] text-[#8f9189]">CONFIGURATION</p>
          <div className="space-y-1">
            {secondaryNavItems.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} type="button" onClick={() => { closeMobileNavigation(); setInfoModal({ title: item.label, desc: item.description }); }} className="group flex min-h-10 w-full items-center justify-between px-3 text-sm text-[#a7a99f] transition-colors hover:bg-white/[0.045] hover:text-white">
                  <span className="flex items-center gap-3"><span className="brand-data w-4 text-[10px] text-[#777970]">—</span><Icon size={15} className="text-[#777970] group-hover:text-reloop-paper" /><span>{item.label}</span></span>
                  <span className="brand-data text-[10px] tracking-[0.05em] text-[#777970]">{item.badge}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </div>

      <div className="relative border-t border-white/10 p-4">
        <div className="mb-3 border border-white/10 bg-white/[0.035] p-3.5">
          <div className="flex items-center justify-between">
            <span className="brand-data flex items-center gap-2 text-[10px] font-semibold tracking-[0.07em] text-[#b8bab2]"><span className="h-1.5 w-1.5 bg-reloop-verified motion-breathe" />LIVE PROTECTION</span>
            <span className="brand-data text-[10px] text-[#777970]">V0.1.0</span>
          </div>
          <p className="mt-2 text-xs leading-5 text-[#92948c]">Cross-system integrity monitoring is active.</p>
        </div>
        <div className="relative">
          <button onClick={() => setShowUserMenu((visible) => !visible)} className="flex w-full items-center justify-between px-1 py-2 text-left">
            <span className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-reloop-signal/50 bg-reloop-signal/10 text-xs font-semibold text-reloop-signal">{initials}</span>
              <span className="min-w-0"><span className="block truncate text-xs font-semibold text-reloop-paper">{user?.name || 'Operator'}</span><span className="brand-data mt-1 block text-[10px] tracking-[0.05em] text-[#8f9189]">{role || 'VIEWER'}</span></span>
            </span>
            <ChevronDownIcon size={12} className="text-[#666860]" />
          </button>
          {showUserMenu && (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-2 border border-white/10 bg-[#24251f] p-1 shadow-elevated">
              <div className="border-b border-white/10 px-3 py-2"><p className="truncate text-xs font-medium">{user?.email}</p></div>
              <button onClick={() => { setShowUserMenu(false); logout(); }} className="mt-1 w-full px-3 py-2 text-left text-xs text-[#ff8e73] hover:bg-white/[0.05]">Sign out</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-reloop-canvas font-sans text-reloop-ink antialiased selection:bg-reloop-signal-soft selection:text-reloop-signal-hover">
      <aside className="sticky top-0 z-20 hidden h-screen w-[276px] shrink-0 md:block">{sidebarContent}</aside>
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <button aria-label="Close navigation menu" className="fixed inset-0 bg-reloop-ink/55 backdrop-blur-sm" onClick={closeMobileNavigation} />
          <div className="relative z-10 h-full w-[286px] shadow-elevated">{sidebarContent}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-[68px] shrink-0 items-center justify-between border-b border-reloop-line bg-reloop-paper/95 px-4 backdrop-blur-md sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <button onClick={() => setMobileMenuOpen(true)} className="flex h-9 w-9 items-center justify-center border border-reloop-line text-reloop-muted md:hidden" aria-label="Open navigation menu"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M4 12h16M4 17h16" /></svg></button>
            <div className="min-w-0">
              <p className="brand-data text-[10px] font-semibold tracking-[0.08em] text-reloop-signal-hover sm:text-[11px]">OPERATIONS / {activeTab.toUpperCase()}</p>
              <h1 className="mt-1 truncate text-sm font-semibold tracking-[-0.02em]">{pageLabels[activeTab]}</h1>
            </div>
            <span className="hidden h-7 w-px bg-reloop-line sm:block" />
            <span className="hidden truncate text-xs text-reloop-muted sm:block">{organization?.name || 'Production workspace'}</span>
          </div>

          <div className="flex items-center gap-2.5">
            <div className={`hidden items-center gap-2 border px-2.5 py-1.5 brand-data text-[11px] font-semibold tracking-[0.05em] sm:flex ${realtimeStatus === 'CONNECTED' ? 'border-reloop-verified/25 bg-reloop-verified-soft text-reloop-verified' : realtimeStatus === 'RECONNECTING' ? 'border-reloop-warning/25 bg-reloop-warning-soft text-reloop-warning' : 'border-reloop-line bg-reloop-surface text-reloop-faint'}`}>
              <span className={`h-1.5 w-1.5 ${realtimeStatus === 'CONNECTED' ? 'bg-reloop-verified motion-breathe' : realtimeStatus === 'RECONNECTING' ? 'bg-reloop-warning animate-pulse' : 'bg-reloop-faint'}`} />
              {realtimeStatus === 'CONNECTED' ? 'LIVE' : realtimeStatus === 'RECONNECTING' ? 'SYNCING' : 'OFFLINE'}
            </div>
            <form onSubmit={handleSearchSubmit} className="relative hidden w-48 lg:block xl:w-64">
              <SearchIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-reloop-faint" />
              <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search operational records" className="h-9 w-full border border-reloop-line bg-reloop-surface pl-9 pr-9 text-xs outline-none transition-colors placeholder:text-reloop-faint focus:border-reloop-line-strong" />
              <span className="brand-data absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-reloop-faint">↵</span>
            </form>
            <button title="Notifications" className="relative flex h-9 w-9 items-center justify-center border border-reloop-line bg-reloop-surface text-reloop-muted transition-colors hover:border-reloop-line-strong hover:text-reloop-ink">
              <BellIcon size={15} />
              {openExceptionsCount > 0 && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 bg-reloop-signal ring-2 ring-reloop-surface" />}
            </button>
            <span className="hidden h-9 w-9 items-center justify-center bg-reloop-ink text-[10px] font-semibold text-reloop-paper sm:flex">{initials}</span>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-7 sm:py-8">{children}</main>
      </div>

      {infoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-reloop-ink/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md border border-reloop-line bg-reloop-paper shadow-elevated">
            <div className="flex items-center justify-between border-b border-reloop-line px-6 py-5">
              <div><p className="brand-data text-[11px] tracking-[0.08em] text-reloop-signal-hover">CONTROL PLANE</p><h3 className="mt-2 font-display text-2xl font-[620] tracking-[-0.04em]">{infoModal.title}</h3></div>
              <button onClick={() => setInfoModal(null)} className="flex h-8 w-8 items-center justify-center border border-reloop-line text-reloop-muted hover:text-reloop-ink" aria-label="Close"><XIcon size={15} /></button>
            </div>
            <p className="px-6 py-6 text-sm leading-7 text-reloop-muted">{infoModal.desc}</p>
            <div className="flex justify-end border-t border-reloop-line px-6 py-4"><button onClick={() => setInfoModal(null)} className="brand-button bg-reloop-ink text-reloop-paper">Understood</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
