import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CodeArena',
  description: 'Online judge monorepo scaffold'
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
