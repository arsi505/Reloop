'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/auth-context';
import { apiClient } from '../../lib/api-client';
import { OrganizationMemberDto } from '@reloop/contracts';

export default function DashboardPage() {
  const { user, organization, role, isLoading, isAuthenticated, refreshSession, logout, logoutAll, setOrganization } = useAuth();
  const router = useRouter();

  const [members, setMembers] = useState<OrganizationMemberDto[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);

  // Edit Org Name state
  const [editName, setEditName] = useState('');
  const [isEditingOrg, setIsEditingOrg] = useState(false);
  const [updateOrgMsg, setUpdateOrgMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    if (organization) {
      setEditName(organization.name);
      fetchMembers();
    }
  }, [organization]);

  const fetchMembers = async () => {
    setLoadingMembers(true);
    try {
      const data = await apiClient.getOrganizationMembers();
      setMembers(data);
    } catch (err: unknown) {
      console.error('Failed to load organization members:', err);
    } finally {
      setLoadingMembers(false);
    }
  };

  const handleManualRefresh = async () => {
    setIsActionLoading(true);
    setRefreshStatus('Executing refresh...');
    const ok = await refreshSession();
    if (ok) {
      setRefreshStatus(`Token refreshed successfully at ${new Date().toLocaleTimeString()}`);
    } else {
      setRefreshStatus('Failed to refresh token');
    }
    setIsActionLoading(false);
    setTimeout(() => setRefreshStatus(null), 4000);
  };

  const handleUpdateOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    setUpdateOrgMsg(null);
    try {
      const updated = await apiClient.updateCurrentOrganization({ name: editName });
      setOrganization(updated);
      setIsEditingOrg(false);
      setUpdateOrgMsg({ type: 'success', text: 'Organization name updated successfully!' });
    } catch (err: unknown) {
      setUpdateOrgMsg({ type: 'error', text: (err instanceof Error ? err.message : "Error") || 'Failed to update organization' });
    }
    setTimeout(() => setUpdateOrgMsg(null), 4000);
  };

  if (isLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-900 text-slate-400">
        <div className="flex items-center space-x-3 text-sm">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <span>Verifying secure session...</span>
        </div>
      </main>
    );
  }

  if (!isAuthenticated || !user || !organization) {
    return null;
  }

  const roleColors: Record<string, string> = {
    OWNER: 'bg-purple-950/80 text-purple-300 border-purple-800',
    ADMIN: 'bg-blue-950/80 text-blue-300 border-blue-800',
    OPERATOR: 'bg-emerald-950/80 text-emerald-300 border-emerald-800',
    VIEWER: 'bg-slate-800 text-slate-300 border-slate-700',
  };

  const canEditOrg = role === 'OWNER' || role === 'ADMIN';

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
      {/* Top Navigation */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-10 px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-base shadow-sm">
            R
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-semibold text-sm text-white">{organization.name}</span>
              <span className="text-xs text-slate-500 font-mono">({organization.slug})</span>
              <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${roleColors[role || 'VIEWER']}`}>
                {role}
              </span>
            </div>
            <p className="text-xs text-slate-400">Reloop Reliability Engine</p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={handleManualRefresh}
            disabled={isActionLoading}
            className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition-colors"
          >
            Refresh Session
          </button>
          <button
            onClick={logout}
            className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-rose-950 hover:text-rose-200 hover:border-rose-800 text-slate-300 border border-slate-700 rounded-lg transition-colors"
          >
            Log Out
          </button>
          <button
            onClick={logoutAll}
            className="px-3 py-1.5 text-xs font-medium bg-rose-950/60 hover:bg-rose-900/80 text-rose-300 border border-rose-800/80 rounded-lg transition-colors"
          >
            Log Out Everywhere
          </button>
        </div>
      </header>

      {/* Main Body */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-8 space-y-6">
        {/* Status Toast */}
        {refreshStatus && (
          <div className="p-3 rounded-lg bg-blue-950/80 border border-blue-800 text-blue-200 text-xs flex items-center justify-between animate-fadeIn">
            <span>{refreshStatus}</span>
          </div>
        )}
        {updateOrgMsg && (
          <div
            className={`p-3 rounded-lg text-xs flex items-center justify-between ${
              updateOrgMsg.type === 'success'
                ? 'bg-emerald-950/80 border border-emerald-800 text-emerald-200'
                : 'bg-rose-950/80 border border-rose-800 text-rose-200'
            }`}
          >
            <span>{updateOrgMsg.text}</span>
          </div>
        )}

        {/* Security / Session Card */}
        <div className="bg-slate-800/60 border border-slate-700/80 rounded-xl p-6 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-700/60 gap-4">
            <div>
              <h2 className="text-sm font-semibold text-white uppercase tracking-wider">Session Security State</h2>
              <p className="text-xs text-slate-400 mt-0.5">Strict architectural isolation verified</p>
            </div>
            <div className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-950/80 text-emerald-300 border border-emerald-800">
              <span className="w-2 h-2 rounded-full bg-emerald-400 mr-2 animate-pulse"></span>
              Active (Memory-only Access Token + HttpOnly Refresh Cookie)
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-5 text-xs">
            <div className="bg-slate-900/70 border border-slate-800 p-3.5 rounded-lg">
              <span className="text-slate-400 block mb-1">Authenticated User</span>
              <span className="font-medium text-white block text-sm">{user.name}</span>
              <span className="text-slate-400 font-mono text-[11px] truncate block">{user.email}</span>
            </div>
            <div className="bg-slate-900/70 border border-slate-800 p-3.5 rounded-lg">
              <span className="text-slate-400 block mb-1">Assigned Tenant / Org</span>
              <span className="font-medium text-white block text-sm">{organization.name}</span>
              <span className="text-slate-400 font-mono text-[11px] truncate block">ID: {organization.id}</span>
            </div>
            <div className="bg-slate-900/70 border border-slate-800 p-3.5 rounded-lg">
              <span className="text-slate-400 block mb-1">Role & Authority</span>
              <span className="font-medium text-white block text-sm">{role}</span>
              <span className="text-slate-400 text-[11px] block">
                {canEditOrg ? 'Settings modification allowed' : 'Read-only access'}
              </span>
            </div>
            <div className="bg-slate-900/70 border border-slate-800 p-3.5 rounded-lg">
              <span className="text-slate-400 block mb-1">Storage Guarantee</span>
              <span className="font-medium text-emerald-400 block text-sm">Zero Browser Storage</span>
              <span className="text-slate-400 text-[11px] block">No localStorage / sessionStorage</span>
            </div>
          </div>
        </div>

        {/* Organization Management Card */}
        <div className="bg-slate-800/60 border border-slate-700/80 rounded-xl p-6 shadow-sm">
          <div className="flex items-center justify-between pb-4 border-b border-slate-700/60">
            <div>
              <h2 className="text-sm font-semibold text-white uppercase tracking-wider">Tenant Settings</h2>
              <p className="text-xs text-slate-400 mt-0.5">Organization metadata and RBAC control</p>
            </div>
            {canEditOrg && !isEditingOrg && (
              <button
                onClick={() => setIsEditingOrg(true)}
                className="px-3 py-1 text-xs font-medium bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-700 rounded-lg transition-colors"
              >
                Rename Organization
              </button>
            )}
          </div>

          {isEditingOrg ? (
            <form onSubmit={handleUpdateOrg} className="mt-4 flex items-center space-x-3">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
                className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsEditingOrg(false);
                  setEditName(organization.name);
                }}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium"
              >
                Cancel
              </button>
            </form>
          ) : (
            <div className="mt-4 flex items-center space-x-4 text-xs">
              <span className="text-slate-400">Current Name: <strong className="text-white">{organization.name}</strong></span>
              <span className="text-slate-400">Slug: <code className="bg-slate-900 px-1.5 py-0.5 rounded font-mono text-slate-300">{organization.slug}</code></span>
              <span className="text-slate-400">Created: {new Date(organization.createdAt).toLocaleDateString()}</span>
            </div>
          )}
        </div>

        {/* Organization Members Table */}
        <div className="bg-slate-800/60 border border-slate-700/80 rounded-xl p-6 shadow-sm">
          <div className="flex items-center justify-between pb-4 border-b border-slate-700/60">
            <div>
              <h2 className="text-sm font-semibold text-white uppercase tracking-wider">Organization Members</h2>
              <p className="text-xs text-slate-400 mt-0.5">Isolated to tenant ID: <code className="font-mono text-blue-400">{organization.id}</code></p>
            </div>
            <button
              onClick={fetchMembers}
              disabled={loadingMembers}
              className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              {loadingMembers ? 'Loading...' : 'Refresh List'}
            </button>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-700/60 text-slate-400">
                  <th className="pb-3 font-medium">Member</th>
                  <th className="pb-3 font-medium">Email</th>
                  <th className="pb-3 font-medium">Role</th>
                  <th className="pb-3 font-medium">Joined At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {members.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-800/40">
                    <td className="py-3 font-medium text-white flex items-center space-x-2">
                      <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-[10px] font-bold text-slate-300">
                        {m.name.charAt(0).toUpperCase()}
                      </div>
                      <span>{m.name}</span>
                      {m.userId === user.id && (
                        <span className="text-[10px] text-blue-400 font-normal">(You)</span>
                      )}
                    </td>
                    <td className="py-3 text-slate-300 font-mono">{m.email}</td>
                    <td className="py-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${roleColors[m.role]}`}>
                        {m.role}
                      </span>
                    </td>
                    <td className="py-3 text-slate-400">{new Date(m.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
