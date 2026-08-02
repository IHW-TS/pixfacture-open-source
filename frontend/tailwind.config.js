/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./src/figma/app/**/*.{js,ts,jsx,tsx}",
    "./src/figma-compare/**/*.{js,ts,jsx,tsx}",
    "./src/figma/imports/**/*.{js,ts,jsx,tsx,md,mdx,json,txt}",
    "./src/app/**/*.{js,ts,jsx,tsx}",
    "./src/components/**/*.{js,ts,jsx,tsx}",
    "./figma-compare-srcs/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-2)",
          50: "#eff6ff",
          100: "#dbeafe",
          500: "#2563eb",
          600: "#1d4ed8",
          700: "#1e40af",
        },
        surface: {
          DEFAULT: "var(--card)",
          soft: "var(--bg-soft)",
          page: "#f8fafc",
        },
        semantic: {
          success: "var(--success)",
          warning: "var(--warning)",
          danger: "var(--danger)",
          info: "var(--info)",
        },
        txt: {
          primary: "var(--fg)",
          secondary: "#64748b",
          muted: "#94a3b8",
        },
      },
      borderRadius: {
        card: "var(--radius)",
        "card-lg": "var(--radius-lg)",
      },
      boxShadow: {
        card: "var(--shadow)",
        "card-lg": "var(--shadow-lg)",
      },
      transitionDuration: {
        fast: "var(--motion-fast)",
        med: "var(--motion-med)",
        slow: "var(--motion-slow)",
      },
    },
  },
  plugins: [],
};
