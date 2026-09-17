import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Reloop | E-commerce Reliability & Recovery Engine',
  description: 'B2B SaaS reliability platform for growing Shopify brands',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
