'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LegacyAppRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/dashboard');
  }, [router]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#fbfbfa] text-[#71717a]">
      <div className="flex items-center space-x-3 text-xs">
        <div className="w-4 h-4 border-2 border-[#f95721] border-t-transparent rounded-full animate-spin" />
        <span>Loading operations workspace...</span>
      </div>
    </main>
  );
}
