// tailwind.config.cjs
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        primary: "hsl(210, 45%, 20%)",
        secondary: "hsl(34, 55%, 45%)",
        accent: "hsl(160, 40%, 55%)",
        background: "hsl(0, 0%, 96%)",
        "tile-back": "hsl(210, 30%, 30%)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"]
      }
    }
  },
  plugins: []
};
