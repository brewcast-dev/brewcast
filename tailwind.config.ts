import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // ── Obsidian palette ────────────────────────────────────────────────
        // Surfaces stack: ink (pure black bg) → obsidian (cards) → onyx (hover)
        ink:       "#000000",
        obsidian:  "#0a0a0a",
        onyx:      "#141414",
        slate:     "#1d1d1d",

        // Warm off-white text. Cream > white. Stark white feels sterile here.
        cream:     "#ede5d8",
        bone:      "#d6cfc2",
        ash:       "#8a8580",   // muted body text
        smoke:     "#5a5650",   // hint / disabled

        // Accents — used sparingly
        emerald:   "#4ade80",   // status / success
        ember:     "#f97316",   // highlight / sparkle
      },
      fontFamily: {
        sans:    ["var(--font-inter)", "system-ui", "sans-serif"],
        display: ["var(--font-fraunces)", "Georgia", "serif"],
      },
      backgroundImage: {
        "glass-light": "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)",
      },
      backdropBlur: {
        xs: "2px",
      },
      borderColor: {
        hairline: "rgba(255,255,255,0.08)",
      },
    },
  },
  plugins: [],
};
export default config;
