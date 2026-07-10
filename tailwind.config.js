/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        cream: {
          50:  '#fefdf8',
          100: '#fdf9ed',
          200: '#faf0d0',
          300: '#f5e4a8',
        },
        stone: {
          50:  '#faf9f7',
          100: '#f4f1ea',
          200: '#e8e2d5',
          300: '#d5ccb8',
          400: '#b8a98a',
          500: '#8c7a5e',
          600: '#6b5c42',
          700: '#4a3f2e',
          800: '#2e261a',
          900: '#1a140e',
        },
        peach: {
          100: '#fde8df',
          200: '#fbd0c0',
          300: '#f9b8a0',
          400: '#f4956f',
          500: '#e8744a',
        },
        sage: {
          100: '#e0edd9',
          200: '#c4deba',
          300: '#a8c5a0',
          400: '#7fad75',
          500: '#5a9250',
        },
        amber: {
          100: '#fef0cd',
          200: '#fce29a',
          300: '#f5c878',
          400: '#f0b040',
          500: '#d9920a',
        },
        rose: {
          100: '#fde3e8',
          200: '#fbc6cf',
          300: '#f4a0ae',
          400: '#e87080',
          500: '#d44060',
        },
      },
      fontFamily: {
        sans: ['Pretendard', 'system-ui', '-apple-system', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '8px',
      },
    },
  },
  plugins: [],
}
