/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Zama brand colors
        'zama-yellow': '#FFD208',
        'zama-black': '#000000',
        'zama-gray': {
          50: '#f5f5f5',
          100: '#e0e0e0',
          200: '#888888',
          300: '#666666',
          400: '#333333',
          500: '#2a2a2a',
          600: '#1a1a1a',
          700: '#000000',
        },
        'zama-green': '#4caf50',
        'zama-red': '#f44336',
        'zama-orange': '#ff9800',
        'zama-blue': '#007bff',
        'primary': '#FFDE59',
        'secondary': '#FF66C4',
        'neo-black': '#000000',
        'neo-white': '#ffffff',
        'background-light': '#FFDE59',
        'background-dark': '#FFDE59',
        'surface': '#ffffff',
      },
      fontFamily: {
        'system': ['system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        'zama': '0 4px 12px rgba(0, 0, 0, 0.3)',
        'neo': '8px 8px 0px 0px #000000',
        'neo-hover': '4px 4px 0px 0px #000000',
        'neo-sm': '4px 4px 0px 0px #000000',
      },
      borderWidth: {
        '3': '3px',
        '5': '5px',
        '6': '6px',
      },
      keyframes: {
        marquee: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
      },
      animation: {
        marquee: 'marquee 20s linear infinite',
      },
    },
  },
  plugins: [],
}
