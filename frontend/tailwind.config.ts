import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      // "Judge Slip — Mono" direction tokens — near-black canvas, plain white-outline
      // chrome (no filled/colored buttons or chips), typewriter voice kept from the
      // paper direction. Verdict colors are the one place color survives — they carry
      // pass/fail meaning, not decoration. See the UI redesign plan for rationale.
      colors: {
        canvas: '#0A0A0A',
        surface: '#141414',
        surface2: '#1C1C1C',
        ink: '#F2F2F2',
        line: '#ADADAD',
        accent: '#5B90C4',
        verdict: {
          ac: '#4FA875',
          wa: '#C6553D',
          re: '#C6553D',
          tle: '#C98A3B',
          mle: '#C98A3B',
          ce: '#8A8F94',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'ui-monospace', 'monospace'],
        body: ['var(--font-body)', 'ui-monospace', 'monospace'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        // Hard offset, no blur — the stamp is stamped, not glowing.
        stamp: '2px 2px 0 0 rgba(0, 0, 0, 0.6)',
        emboss: '0 2px 0 0 rgba(0, 0, 0, 0.5)',
      },
      keyframes: {
        'stamp-in': {
          '0%': { transform: 'scale(1.15) rotate(-2deg)', opacity: '0' },
          '60%': { transform: 'scale(0.97) rotate(-2deg)', opacity: '1' },
          '100%': { transform: 'scale(1) rotate(-2deg)', opacity: '1' },
        },
      },
      animation: {
        'stamp-in': 'stamp-in 150ms ease-out',
      },
    },
  },
  plugins: [],
} satisfies Config;
