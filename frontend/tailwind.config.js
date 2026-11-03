/** @type {import('tailwindcss').Config} */
const v = (name) => `var(--${name})`;
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: v("bg"), surface: v("surface"), ink: v("ink"), muted: v("muted"),
        line: v("line"), "line-strong": v("line-strong"),
        accent: v("accent"), "accent-soft": v("accent-soft"),
        llm: v("llm"), "llm-soft": v("llm-soft"),
        human: v("human"), "human-soft": v("human-soft"),
        ok: v("ok"), "ok-soft": v("ok-soft"),
        warn: v("warn"), "warn-soft": v("warn-soft"),
        bad: v("bad"), "bad-soft": v("bad-soft"),
      },
      fontFamily: {
        display: ['"IBM Plex Sans Condensed"', '"Arial Narrow"', "system-ui", "sans-serif"],
        sans: ['"IBM Plex Sans"', "system-ui", "-apple-system", '"Segoe UI"', "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", '"SF Mono"', "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
