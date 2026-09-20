'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/auth-context';
import {
  ReloopLogo,
  DashboardIcon,
  ExceptionsIcon,
  OrdersIcon,
  RecoveriesIcon,
  IntegrationsIcon,
  HealthIcon,
  RulesIcon,
  AnalyticsIcon,
  SettingsIcon,
  SearchIcon,
  BellIcon,
  ChevronDownIcon,
} from '../icons/Icons';

export type NavTab =
  | 'dashboard'
  | 'exceptions'
  | 'orders'
  | 'recoveries'
  | 'integrations'
  | 'health'
  | 'rules'
  | 'analytics'
  | 'settings';

interface AppShellProps {
  children: React.ReactNode;
  activeTab: NavTab;
  openExceptionsCount?: number;
}

export function AppShell({
  children,
  activeTab,
  openExceptionsCount = 0,
}: AppShellProps) {
  const { user, organization, role, logout } = useAuth();
  const router = useRouter();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const initials = user?.name
    ? user.name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : 'OP';

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      router.push(`/exceptions?search=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  const navItems: {
    id: NavTab;
    label: string;
    href: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
    badge?: number;
  }[] = [
    { id: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: DashboardIcon },
    {
      id: 'exceptions',
      label: 'Exceptions',
      href: '/exceptions',
      icon: ExceptionsIcon,
      badge: openExceptionsCount > 0 ? openExceptionsCount : undefined,
    },
    { id: 'orders', label: 'Orders', href: '/orders', icon: OrdersIcon },
    { id: 'recoveries', label: 'Recoveries', href: '/recoveries', icon: RecoveriesIcon },
    { id: 'integrations', label: 'Integrations', href: '/integrations', icon: IntegrationsIcon },
    { id: 'health', label: 'System Health', href: '/health', icon: HealthIcon },
  ];

  const secondaryNavItems: {
    id: NavTab;
    label: string;
    href: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
  }[] = [
    { id: 'rules', label: 'Rules & Logic', href: '/dashboard', icon: RulesIcon },
    { id: 'analytics', label: 'Analytics', href: '/dashboard', icon: AnalyticsIcon },
    { id: 'settings', label: 'Settings', href: '/dashboard', icon: SettingsIcon },
  ];

  const renderSidebarContent = () => (
    <div className="flex flex-col justify-between h-full">
      <div>
        {/* Brand Header */}
        <div className="h-16 px-5 flex items-center gap-3 border-b border-[#ececeb]/80">
          <ReloopLogo size={28} />
          <div className="flex flex-col">
            <span className="font-semibold text-[15px] tracking-tight text-[#18181b] leading-tight">
              Reloop
            </span>
            <span className="text-[11px] text-[#71717a] font-medium leading-none">
              Reliability Engine
            </span>
          </div>
        </div>

        {/* Tenant / Workspace Selector */}
        <div className="px-3 pt-3 pb-2">
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-white border border-[#ececeb] shadow-subtle hover:border-[#d4d4d8] cursor-pointer transition-colors">
            <div className="flex items-center gap-2.5 overflow-hidden">
              <div className="w-5 h-5 rounded bg-[#f4f4f5] text-[#18181b] font-semibold text-[11px] flex items-center justify-center shrink-0 border border-[#e4e4e7]">
                {organization?.name ? organization.name.charAt(0).toUpperCase() : 'O'}
              </div>
              <div className="truncate">
                <p className="text-xs font-medium text-[#18181b] truncate">
                  {organization?.name || 'My Organization'}
                </p>
              </div>
            </div>
            <ChevronDownIcon size={12} className="text-[#71717a] shrink-0" />
          </div>
        </div>

        {/* Primary Navigation */}
        <nav className="px-3 py-2 space-y-1">
          <div className="px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
            Operations
          </div>
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            const Icon = item.icon;
            return (
              <Link
                key={item.id}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-[13px] font-medium transition-all group relative ${
                  isActive
                    ? 'bg-white text-[#18181b] shadow-subtle border border-[#ececeb]'
                    : 'text-[#52525b] hover:bg-[#f4f4f5]/80 hover:text-[#18181b]'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  {isActive && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r bg-[#f95721]" />
                  )}
                  <Icon
                    size={16}
                    className={
                      isActive
                        ? 'text-[#f95721]'
                        : 'text-[#71717a] group-hover:text-[#18181b]'
                    }
                  />
                  <span>{item.label}</span>
                </div>

                {item.badge !== undefined && (
                  <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-[#fff5f1] text-[#f95721] border border-[#ffdcd0]">
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Separator */}
        <div className="px-4 py-2">
          <div className="border-t border-[#ececeb]" />
        </div>

        {/* Secondary Navigation */}
        <nav className="px-3 py-1 space-y-1">
          <div className="px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
            Configuration
          </div>
          {secondaryNavItems.map((item) => {
            const isActive = activeTab === item.id;
            const Icon = item.icon;
            return (
              <Link
                key={item.id}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-[13px] font-medium transition-all group relative ${
                  isActive
                    ? 'bg-white text-[#18181b] shadow-subtle border border-[#ececeb]'
                    : 'text-[#52525b] hover:bg-[#f4f4f5]/80 hover:text-[#18181b]'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon
                    size={16}
                    className={
                      isActive
                        ? 'text-[#f95721]'
                        : 'text-[#71717a] group-hover:text-[#18181b]'
                    }
                  />
                  <span>{item.label}</span>
                </div>
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Bottom Section: Promo/Status Card & User Profile */}
      <div className="p-3 space-y-3">
        {/* Recovery Active Card */}
        <div className="p-3 rounded-lg bg-white border border-[#ececeb] shadow-subtle">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-[#18181b] uppercase tracking-wider flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#10b981] animate-pulse" />
              Live Protection
            </span>
            <span className="text-[10px] text-[#71717a]">v0.1.0</span>
          </div>
          <p className="text-[11px] text-[#71717a] leading-relaxed">
            Read-only cross-system integrity monitoring is active.
          </p>
        </div>

        {/* User Account / Role Row */}
        <div className="relative">
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-white hover:shadow-subtle hover:border hover:border-[#ececeb] transition-all"
          >
            <div className="flex items-center gap-2.5 overflow-hidden">
              <div className="w-8 h-8 rounded-full bg-[#fff0eb] text-[#f95721] font-semibold text-xs flex items-center justify-center shrink-0 border border-[#ffdcd0]">
                {initials}
              </div>
              <div className="text-left truncate">
                <p className="text-xs font-semibold text-[#18181b] truncate">
                  {user?.name || 'Operator'}
                </p>
                <p className="text-[11px] text-[#71717a] truncate">
                  {role || 'VIEWER'}
                </p>
              </div>
            </div>
            <ChevronDownIcon size={12} className="text-[#71717a] shrink-0" />
          </button>

          {/* Dropdown Menu */}
          {showUserMenu && (
            <div className="absolute bottom-full left-0 right-0 mb-2 bg-white rounded-lg border border-[#ececeb] shadow-lg py-1 text-xs z-30 animate-fadeIn">
              <div className="px-3 py-2 border-b border-[#ececeb]">
                <p className="font-medium text-[#18181b]">{user?.name}</p>
                <p className="text-[#71717a] font-mono text-[10px] truncate">{user?.email}</p>
              </div>
              <button
                onClick={() => {
                  setShowUserMenu(false);
                  logout();
                }}
                className="w-full text-left px-3 py-2 text-[#b91c1c] hover:bg-[#fef2f2]"
              >
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#fbfbfa] text-[#18181b] flex font-sans antialiased selection:bg-[#fff0eb] selection:text-[#f95721]">
      {/* Desktop Left Sidebar (hidden on mobile) */}
      <aside className="hidden md:flex w-64 bg-[#fbfbfa] border-r border-[#ececeb] flex-col justify-between shrink-0 select-none z-20 sticky top-0 h-screen">
        {renderSidebarContent()}
      </aside>

      {/* Mobile Slide-over Sidebar Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div
            className="fixed inset-0 bg-black/25 backdrop-blur-sm"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative w-64 bg-[#fbfbfa] h-full shadow-2xl z-10 flex flex-col justify-between">
            {renderSidebarContent()}
          </div>
        </div>
      )}

      {/* Main Column */}
      <div className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
        {/* Top Header Bar */}
        <header className="h-16 bg-white border-b border-[#ececeb] px-4 sm:px-6 flex items-center justify-between shrink-0 sticky top-0 z-10">
          <div className="flex items-center gap-3">
            {/* Mobile Hamburger Menu Button */}
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="md:hidden p-1.5 rounded-lg text-[#71717a] hover:text-[#18181b] hover:bg-[#f4f4f5]"
              aria-label="Open navigation menu"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>

            <h1 className="text-base font-semibold text-[#18181b] tracking-tight capitalize">
              {activeTab === 'dashboard' ? 'Operations Overview' : activeTab}
            </h1>
            <span className="text-xs text-[#a1a1aa] hidden sm:inline">/</span>
            <span className="text-xs text-[#71717a] font-medium hidden sm:inline">
              {organization?.name || 'Production'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            {/* Search Input Form */}
            <form onSubmit={handleSearchSubmit} className="relative w-44 sm:w-64">
              <SearchIcon
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a1a1aa]"
              />
              <input
                type="text"
                placeholder="Search orders, exceptions..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-10 py-1.5 text-xs bg-[#fbfbfa] border border-[#ececeb] rounded-lg text-[#18181b] placeholder-[#a1a1aa] focus:outline-none focus:bg-white focus:border-[#d4d4d8] transition-colors"
              />
              <button
                type="submit"
                className="absolute right-2 top-1/2 -translate-y-1/2 px-1 py-0.5 text-[10px] font-mono text-[#a1a1aa] hover:text-[#18181b]"
              >
                ↵
              </button>
            </form>

            {/* Notification Bell */}
            <button
              title="Notifications"
              className="relative p-2 rounded-lg text-[#71717a] hover:text-[#18181b] hover:bg-[#f4f4f5] border border-transparent hover:border-[#ececeb] transition-all"
            >
              <BellIcon size={16} />
              {openExceptionsCount > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#f95721] ring-2 ring-white" />
              )}
            </button>

            {/* Avatar Circle */}
            <div className="w-8 h-8 rounded-full bg-[#fff0eb] text-[#f95721] font-semibold text-xs flex items-center justify-center border border-[#ffdcd0]">
              {initials}
            </div>
          </div>
        </header>

        {/* Scrollable Main Content Surface */}
        <main className="flex-1 p-4 sm:p-6 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
