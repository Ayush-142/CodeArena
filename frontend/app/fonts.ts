import { Courier_Prime, JetBrains_Mono } from 'next/font/google';

// next/font/google self-hosts at build time — no runtime dependency on Google's CDN.
// "Judge Slip — Paper" direction: a single typewriter voice for display + body text
// (Courier Prime), matching the stamped-ledger/paper aesthetic, with a dedicated
// monospace for code (JetBrains Mono has better glyph disambiguation at small sizes
// than Courier Prime, so the editor keeps its own font while still reading as "typed").
export const displayFont = Courier_Prime({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-display',
  display: 'swap',
});

export const bodyFont = Courier_Prime({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-body',
  display: 'swap',
});

export const monoFont = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});
