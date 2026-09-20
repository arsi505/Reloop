'use client';

import React from 'react';
import { AuthProvider } from '../context/auth-context';
import { RealtimeProvider } from '../context/realtime-context';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <RealtimeProvider>{children}</RealtimeProvider>
    </AuthProvider>
  );
}