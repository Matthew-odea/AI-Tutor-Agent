/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Themed via CSS vars in src/index.css. The rgb(var(--x) / <alpha-value>) form is
        // required: with a bare var(--x), `/alpha` classes silently emit no CSS.
        paper: 'rgb(var(--color-paper) / <alpha-value>)',
        ink: 'rgb(var(--color-ink) / <alpha-value>)',
        slate: 'rgb(var(--color-slate) / <alpha-value>)',
        hairline: 'var(--color-hairline)', // already translucent; no alpha modifier

        accent: {
          DEFAULT: 'rgb(var(--color-accent) / <alpha-value>)',
          hover: 'rgb(var(--color-accent-hover) / <alpha-value>)',
        },

        // Recording state only.
        record: 'rgb(var(--color-record) / <alpha-value>)',

        success: 'rgb(var(--color-success) / <alpha-value>)',
        caution: 'rgb(var(--color-caution) / <alpha-value>)',
        danger: 'rgb(var(--color-danger) / <alpha-value>)',

        // Legacy alias for surviving `primary-*` classes. Prefer `accent` in new code.
        primary: {
          50: '#E6F2EF',
          100: '#CCE5DF',
          200: '#99CCBF',
          300: '#66B29F',
          400: '#33997F',
          500: 'rgb(var(--color-accent) / <alpha-value>)',
          600: 'rgb(var(--color-accent) / <alpha-value>)',
          700: 'rgb(var(--color-accent-hover) / <alpha-value>)',
          800: 'rgb(var(--color-accent-hover) / <alpha-value>)',
          900: 'rgb(var(--color-accent-hover) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        serif: ['Fraunces', 'Georgia', 'serif'],
        mono: ['Fira Code', 'monospace'],
      },
      borderRadius: {
        card: 'var(--radius-card)',
      },
      boxShadow: {
        // Overlays/modals only; cards use hairline borders.
        overlay: 'var(--elevation-overlay)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-in-out',
        'slide-up': 'slideUp 0.3s ease-in-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
