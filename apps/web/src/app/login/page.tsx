'use client';

import React, { useState } from 'react';
import { useAuth } from '../../context/auth-context';
import { AuthShell } from '../../components/auth/AuthShell';

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await login({ email, password });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed. Please verify your credentials.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthShell
      mode="login"
      eyebrow="01 / OPERATOR ACCESS"
      title="Resume operations."
      description="Sign in to review exceptions, approve recovery actions, and verify that provider state is aligned."
    >
        {error && (
          <div role="alert" className="mb-6 border border-reloop-critical/30 bg-reloop-critical-soft px-4 py-3 text-xs leading-5 text-reloop-critical">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="email" className="brand-data mb-2 block text-[11px] font-semibold tracking-[0.06em] text-reloop-muted">
              WORK EMAIL
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="operator@brand.com"
              className="h-13 w-full border border-reloop-line-strong bg-reloop-surface px-4 py-3.5 text-sm text-reloop-ink shadow-subtle outline-none transition focus:border-reloop-ink focus:shadow-[inset_3px_0_0_var(--color-signal)] placeholder:text-reloop-faint"
            />
          </div>

          <div>
            <label htmlFor="password" className="brand-data mb-2 block text-[11px] font-semibold tracking-[0.06em] text-reloop-muted">PASSWORD</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              className="h-13 w-full border border-reloop-line-strong bg-reloop-surface px-4 py-3.5 text-sm text-reloop-ink shadow-subtle outline-none transition focus:border-reloop-ink focus:shadow-[inset_3px_0_0_var(--color-signal)] placeholder:text-reloop-faint"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="brand-button brand-button-primary mt-2 min-h-[52px] w-full disabled:cursor-not-allowed disabled:opacity-55"
          >
            {isSubmitting ? 'Authenticating…' : 'Enter workspace ↗'}
          </button>
        </form>
    </AuthShell>
  );
}
