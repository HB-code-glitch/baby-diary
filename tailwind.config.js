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
          50: '#fefdf8',
          100: '#fdf9ed',
          200: '#faf0d0',
          300: '#f5e4a8',
        },
        peach: {
          300: '#f9b8a0',
          400: '#f4956f',
          500: '#e8744a',
        },
        sage: {
          300: '#a8c5a0',
          400: '#7fad75',
          500: '#5a9250',
        },
        amber: {
          300: '#f5c878',
          400: '#f0b040',
          500: '#d9920a',
        },
      },
      fontFamily: {
        sans: ['Pretendard', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
