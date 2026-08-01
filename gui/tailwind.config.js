/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        matrix: {
          DEFAULT: '#00ff9c',
          dim: '#00b36b',
          glow: '#00ffc8',
        },
        cyber: {
          bg: '#05060f',
          panel: '#0a0d1a',
          border: '#1c2333',
          neon: '#22d3ee',
          violet: '#a855f7',
        },
        gold: {
          DEFAULT: '#f5c542',
          dim: '#d4a017',
        },
      },
      boxShadow: {
        neon: '0 0 12px rgba(0, 255, 156, 0.45), 0 0 32px rgba(0, 255, 156, 0.15)',
        'neon-cyan': '0 0 12px rgba(34, 211, 238, 0.5)',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'scan': 'scan 4s linear infinite',
      },
      keyframes: {
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
      },
    },
  },
  plugins: [],
};
