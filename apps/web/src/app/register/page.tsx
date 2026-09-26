'use client';

import React, { useState } from 'react';
import { useAuth } from '../../context/auth-context';
import { AuthShell } from '../../components/auth/AuthShell';

export default function RegisterPage() {
  const { register } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    if (password.length < 8) {
      setError('Password must be at least 8 characters long');
      setIsSubmitting(false);
      return;
    }

    try {
      await register({
        name,
        email,
        password,
        organizationName,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Registration failed. Please check your inputs.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthShell
      mode="register"
      eyebrow="01 / WORKSPACE SETUP"
      title="Create your workspace."
      description="Set up your organization workspace and establish its first authorized owner."
    >
        {error && (
          <div role="alert" className="mb-6 border border-reloop-critical/30 bg-reloop-critical-soft px-4 py-3 text-xs leading-5 text-reloop-critical">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="name" className="brand-data mb-2 block text-[11px] font-semibold tracking-[0.06em] text-reloop-muted">FULL NAME</label>
            <input
              id="name"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Alex Vance"
              className="w-full border border-reloop-line-strong bg-reloop-surface px-4 py-3.5 text-sm text-reloop-ink shadow-subtle outline-none transition focus:border-reloop-ink focus:shadow-[inset_3px_0_0_var(--color-signal)] placeholder:text-reloop-faint"
            />
          </div>

          <div>
            <label htmlFor="email" className="brand-data mb-2 block text-[11px] font-semibold tracking-[0.06em] text-reloop-muted">WORK EMAIL</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="alex@acmecorp.com"
              className="w-full border border-reloop-line-strong bg-reloop-surface px-4 py-3.5 text-sm text-reloop-ink shadow-subtle outline-none transition focus:border-reloop-ink focus:shadow-[inset_3px_0_0_var(--color-signal)] placeholder:text-reloop-faint"
            />
          </div>

          <div>
            <label htmlFor="organizationName" className="brand-data mb-2 block text-[11px] font-semibold tracking-[0.06em] text-reloop-muted">ORGANIZATION</label>
            <input
              id="organizationName"
              type="text"
              autoComplete="organization"
              required
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
              placeholder="Acme Supply Co"
              className="w-full border border-reloop-line-strong bg-reloop-surface px-4 py-3.5 text-sm text-reloop-ink shadow-subtle outline-none transition focus:border-reloop-ink focus:shadow-[inset_3px_0_0_var(--color-signal)] placeholder:text-reloop-faint"
            />
          </div>

          <div className="sm:col-span-2">
            <div className="mb-2 flex items-center justify-between">
              <label htmlFor="password" className="brand-data text-[11px] font-semibold tracking-[0.06em] text-reloop-muted">PASSWORD</label>
              <span className="brand-data text-[10px] text-reloop-faint sm:text-[11px]">MINIMUM 8 CHARACTERS</span>
            </div>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Create a secure password"
              className="w-full border border-reloop-line-strong bg-reloop-surface px-4 py-3.5 text-sm text-reloop-ink shadow-subtle outline-none transition focus:border-reloop-ink focus:shadow-[inset_3px_0_0_var(--color-signal)] placeholder:text-reloop-faint"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="brand-button brand-button-primary mt-1 min-h-[52px] w-full disabled:cursor-not-allowed disabled:opacity-55 sm:col-span-2"
          >
            {isSubmitting ? 'Provisioning workspace…' : 'Create workspace ↗'}
          </button>
        </form>
    </AuthShell>
  );
}
