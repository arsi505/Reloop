'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/auth-context';
import { AppShell } from '../../components/layout/AppShell';
import { DashboardView } from '../../components/operations/DashboardView';
import { RecoveryDetailDrawer } from '../../components/operations/RecoveryDetailDrawer';

export default function DashboardRoutePage() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  const [openExceptionsCount, setOpenExceptionsCount] = useState<number>(0);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading || !user) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#fbfbfa] text-[#71717a]">
        <div className="flex items-center space-x-3 text-xs">
          <div className="w-4 h-4 border-2 border-[#f95721] border-t-transparent rounded-full animate-spin" />
          <span>Verifying secure session...</span>
        </div>
      </main>
    );
  }

  return (
    <AppShell activeTab="dashboard" openExceptionsCount={openExceptionsCount}>
      <RecoveryDetailDrawer
        workflowId={selectedWorkflowId}
        onClose={() => setSelectedWorkflowId(null)}
        onViewOrder={(orderId) => router.push(`/orders/${orderId}`)}
      />
      <DashboardView
        userName={user.name}
        onOpenExceptionsCountChange={setOpenExceptionsCount}
        onInspectException={(id) => router.push(`/exceptions/${id}`)}
        onInspectWorkflow={(wfId) => router.push(`/recoveries/${wfId}`)}
      />
    </AppShell>
  );
}
