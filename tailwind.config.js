/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0D0D0F",
          900: "#121214",
          800: "#17171A",
          700: "#1C1C21",
          600: "#232329",
          500: "#2C2C33",
        },
        accent: "#8257E5",
        success: "#04D361",
        warn: "#FBA94C",
        danger: "#F75A68",
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "PingFang SC",
          "Microsoft YaHei",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "Cascadia Code", "Consolas", "monospace"],
      },
      boxShadow: {
        panel: "0 1px 0 rgba(255,255,255,0.04) inset, 0 18px 40px -24px rgba(0,0,0,0.9)",
      },
    },
  },
  plugins: [],
};
