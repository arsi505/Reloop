'use client';

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '../../../context/auth-context';
import { apiClient } from '../../../lib/api-client';
import { AppShell } from '../../../components/layout/AppShell';
import { ExceptionDetailView } from '../../../components/operations/ExceptionDetailView';

export default function ExceptionDetailRoutePage() {
  const params = useParams();
  const router = useRouter();
  const { user, isLoading, isAuthenticated } = useAuth();
  const [openExceptionsCount, setOpenExceptionsCount] = useState<number>(0);

  const exceptionId = Array.isArray(params?.id) ? params.id[0] : (params?.id as string);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    if (isAuthenticated) {
      apiClient
        .getDashboardSummary()
        .then((data) => setOpenExceptionsCount(data.openExceptionsCount))
        .catch(() => {});
    }
  }, [isAuthenticated]);

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
    <AppShell activeTab="exceptions" openExceptionsCount={openExceptionsCount}>
      <ExceptionDetailView exceptionId={exceptionId} />
    </AppShell>
  );
}
