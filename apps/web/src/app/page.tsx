import Link from 'next/link';

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6 bg-slate-900 text-slate-100">
      <div className="max-w-xl w-full bg-slate-800 border border-slate-700 rounded-xl p-8 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-700 pb-4 mb-6">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-lg shadow-sm">
              R
            </div>
            <h1 className="text-xl font-bold tracking-tight text-white">Reloop</h1>
          </div>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-950/80 text-emerald-300 border border-emerald-800">
            Day 3 Auth & Tenancy Active
          </span>
        </div>

        <h2 className="text-base font-semibold text-white mb-2">
          E-commerce Reliability & Recovery Engine
        </h2>
        <p className="text-sm text-slate-300 mb-6 leading-relaxed">
          B2B multi-tenant reliability platform for growing e-commerce brands.
          Operating rule: <code className="text-xs bg-slate-900 px-1.5 py-0.5 rounded font-mono text-blue-300 border border-slate-700">CHECK → EXECUTE → VERIFY → RESOLVED</code>
        </p>

        <div className="grid grid-cols-2 gap-3 mb-6">
          <Link
            href="/login"
            className="flex items-center justify-center py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs rounded-lg transition-colors shadow-sm"
          >
            Sign In to Organization
          </Link>
          <Link
            href="/register"
            className="flex items-center justify-center py-2.5 px-4 bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium text-xs rounded-lg transition-colors border border-slate-600"
          >
            Register Organization
          </Link>
        </div>

        <div className="space-y-3 border-t border-slate-700/60 pt-5">
          <div className="flex justify-between text-xs text-slate-400">
            <span className="font-medium text-slate-300">Tenant Dashboard</span>
            <Link href="/app" className="text-blue-400 hover:underline">/app</Link>
          </div>
          <div className="flex justify-between text-xs text-slate-400">
            <span className="font-medium text-slate-300">Web App (Next.js)</span>
            <span className="font-mono">Port 3100</span>
          </div>
          <div className="flex justify-between text-xs text-slate-400">
            <span className="font-medium text-slate-300">API Gateway (NestJS)</span>
            <span className="font-mono">Port 3101</span>
          </div>
          <div className="flex justify-between text-xs text-slate-400">
            <span className="font-medium text-slate-300">Database (PostgreSQL 16)</span>
            <span className="font-mono">Port 5433 (reloop_app)</span>
          </div>
          <div className="flex justify-between text-xs text-slate-400">
            <span className="font-medium text-slate-300">Session Security</span>
            <span className="text-emerald-400 font-medium">Memory Access Token + HttpOnly Refresh</span>
          </div>
        </div>
      </div>
    </main>
  );
}