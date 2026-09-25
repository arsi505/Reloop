/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        reloop: {
          signal: 'var(--color-signal)',
          'signal-hover': 'var(--color-signal-hover)',
          'signal-soft': 'var(--color-signal-soft)',
          canvas: 'var(--color-canvas)',
          paper: 'var(--color-paper)',
          surface: 'var(--color-surface)',
          ink: 'var(--color-ink)',
          muted: 'var(--color-muted)',
          faint: 'var(--color-faint)',
          line: 'var(--color-line)',
          'line-strong': 'var(--color-line-strong)',
          verified: 'var(--color-verified)',
          'verified-soft': 'var(--color-verified-soft)',
          warning: 'var(--color-warning)',
          'warning-soft': 'var(--color-warning-soft)',
          critical: 'var(--color-critical)',
          'critical-soft': 'var(--color-critical-soft)',
        },
      },
      fontFamily: {
        sans: [
          '"Instrument Sans Variable"',
          '-apple-system',
          'BlinkMacSystemFont',
          'sans-serif',
        ],
        mono: [
          '"IBM Plex Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'monospace',
        ],
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        elevated: 'var(--shadow-elevated)',
        subtle: 'var(--shadow-subtle)',
        signal: 'var(--shadow-signal)',
      },
      borderRadius: {
        brand: 'var(--radius-card)',
        control: 'var(--radius-control)',
      },
      transitionTimingFunction: {
        brand: 'var(--ease-brand)',
      },
      keyframes: {
        'brand-reveal': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'signal-pulse': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(255, 92, 53, 0.28)' },
          '50%': { boxShadow: '0 0 0 7px rgba(255, 92, 53, 0)' },
        },
        shimmer: {
          from: { backgroundPosition: '200% 0' },
          to: { backgroundPosition: '-200% 0' },
        },
      },
      animation: {
        'brand-reveal': 'brand-reveal 600ms var(--ease-brand) both',
        'signal-pulse': 'signal-pulse 2.4s ease-in-out infinite',
        shimmer: 'shimmer 1.8s linear infinite',
      },
    },
  },
  plugins: [],
};
