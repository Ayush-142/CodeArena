import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      // "Judge Slip" direction tokens — see the UI redesign plan for rationale.
      colors: {
        canvas: '#0E1113',
        surface: '#171B1E',
        ink: '#E4E7E6',
        line: '#3A4045',
        accent: '#3E7CB8',
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
        display: ['var(--font-display)', 'ui-sans-serif', 'sans-serif'],
        body: ['var(--font-body)', 'ui-sans-serif', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        // Hard offset, no blur — the stamp is stamped, not glowing.
        stamp: '2px 2px 0 0 rgba(0, 0, 0, 0.55)',
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
