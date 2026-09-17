export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6 bg-slate-50 text-slate-900">
      <div className="max-w-xl w-full bg-white border border-slate-200 rounded-lg p-8 shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 pb-4 mb-6">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded bg-blue-600 flex items-center justify-center text-white font-bold text-lg">
              R
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Reloop</h1>
          </div>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            Day 2 Foundation Active
          </span>
        </div>

        <h2 className="text-base font-semibold text-slate-800 mb-2">
          E-commerce Reliability & Recovery Engine
        </h2>
        <p className="text-sm text-slate-600 mb-6 leading-relaxed">
          Technical architecture and engineering monorepo foundation.
          Operating rule: <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded font-mono text-slate-800">CHECK → EXECUTE → VERIFY → RESOLVED</code>
        </p>

        <div className="space-y-3 border-t border-slate-100 pt-5">
          <div className="flex justify-between text-xs text-slate-500">
            <span className="font-medium text-slate-700">Web App (Next.js)</span>
            <span className="font-mono">Port 3100</span>
          </div>
          <div className="flex justify-between text-xs text-slate-500">
            <span className="font-medium text-slate-700">API Gateway (NestJS)</span>
            <span className="font-mono">Port 3101</span>
          </div>
          <div className="flex justify-between text-xs text-slate-500">
            <span className="font-medium text-slate-700">Database (PostgreSQL 16)</span>
            <span className="font-mono">Port 5433</span>
          </div>
          <div className="flex justify-between text-xs text-slate-500">
            <span className="font-medium text-slate-700">Coordination (Redis 7)</span>
            <span className="font-mono">Port 6380</span>
          </div>
        </div>
      </div>
    </main>
  );
}
