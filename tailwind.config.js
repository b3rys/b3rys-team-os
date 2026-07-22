/** @type {import('tailwindcss').Config} */
// b3rys 대시보드 리디자인 — Phase 1: 색 토큰을 CSS 변수로 백킹.
// 다크 = :root 기본값(styles.css), 라이트 = @media(prefers-color-scheme:light) 오버라이드.
// bg-surface-*/text-slate-*/accent-green 등 기존 클래스가 마크업 0수정으로 자동 테마 적응.
export default {
  darkMode: "media",
  content: [
    "./src/web/**/*.{html,ts,tsx,css}",
    "./src/web/index.html",
  ],
  safelist: [
    // Responsive visibility classes — Tailwind sometimes misses these in template literals,
    // so we force-include the patterns we rely on for the responsive layout.
    "hidden", "block", "inline", "flex", "grid", "contents",
    "sm:hidden", "sm:inline", "sm:block", "sm:flex",
    "md:hidden", "md:inline", "md:block", "md:flex", "md:contents", "md:grid",
    "md:border-l", "md:border-surface-3",
    "md:w-activity", "md:w-sidebar",
    "text-accent-greenSoft",
    "md:h-14", "md:px-4", "md:text-base", "md:text-sm", "md:text-[13px]", "md:gap-5",
    "lg:flex", "lg:hidden",
  ],
  theme: {
    extend: {
      colors: {
        // 표면 — 깊은 배경(0) → 카드(3). 모두 CSS 변수 백킹(라이트/다크 자동).
        surface: {
          0: "rgb(var(--surface-0) / <alpha-value>)",
          1: "rgb(var(--surface-1) / <alpha-value>)",
          2: "rgb(var(--surface-2) / <alpha-value>)",
          3: "rgb(var(--surface-3) / <alpha-value>)",
        },
        accent: {
          green: "rgb(var(--accent) / <alpha-value>)",
          greenHover: "rgb(var(--accent-hover) / <alpha-value>)",
          // greenSoft = 텍스트/아이콘용 가독 소프트그린(var(--accent-soft)는 '채움'배경색이라 텍스트로 안 보임 → 분리).
          greenSoft: "var(--accent-soft-text)",
          // on = accent 버튼 '위' 글자색(다크 어두운글씨 / 라이트 흰글씨) — 테마별 대비 확보.
          on: "var(--on-accent)",
          // btn = accent 버튼 배경(라이트는 더 깊은 초록 → 흰글씨 ≥4.5:1).
          btn: "var(--accent-btn)",
          btnHover: "var(--accent-btn-hover)",
        },
        // slate 텍스트 위계 — 변수 백킹. 다크=밝은 글씨, 라이트=어두운 글씨로 자동 반전.
        slate: {
          50: "rgb(var(--slate-50) / <alpha-value>)",
          100: "rgb(var(--slate-100) / <alpha-value>)",
          200: "rgb(var(--slate-200) / <alpha-value>)",
          300: "rgb(var(--slate-300) / <alpha-value>)",
          400: "rgb(var(--slate-400) / <alpha-value>)",
          500: "rgb(var(--slate-500) / <alpha-value>)",
          600: "rgb(var(--slate-600) / <alpha-value>)",
          700: "rgb(var(--slate-700) / <alpha-value>)",
          900: "rgb(var(--slate-900) / <alpha-value>)",
          950: "rgb(var(--slate-950) / <alpha-value>)",
        },
        status: {
          running: "rgb(var(--status-running) / <alpha-value>)",
          idle: "rgb(var(--status-idle) / <alpha-value>)",
          blocked: "rgb(var(--status-blocked) / <alpha-value>)",
          offline: "rgb(var(--status-offline) / <alpha-value>)",
          info: "rgb(var(--status-info) / <alpha-value>)",
        },
        // 배지/칩 '텍스트' 전용(상태토큰=dot/fill, txt=작은 라벨 가독 ≥4.5:1 라이트/다크).
        txt: {
          green: "var(--txt-green)",
          red: "var(--txt-red)",
          blue: "var(--txt-blue)",
          amber: "var(--txt-amber)",
          violet: "var(--txt-violet)",
          orange: "var(--txt-orange)",
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Menlo", "Courier New", "monospace"],
        sans: ["-apple-system", "BlinkMacSystemFont", "SF Pro Text", "Inter", "system-ui", "sans-serif"],
      },
      // var(rgb채널) 색에는 '스케일에 있는' opacity만 유틸이 생성된다(비표준 /12·/14·/35 등은 누락).
      // 디자인서 쓰는 비표준 alpha 값을 스케일에 명시 추가 → bg-accent-green/12, bg-status-running/14 등 생성 보장.
      opacity: {
        8: "0.08", 12: "0.12", 14: "0.14", 35: "0.35", 55: "0.55", 65: "0.65", 85: "0.85",
      },
      width: {
        sidebar: "280px",
        activity: "360px",
      },
      // border-surface-3 = bg와 분리된 얇은 헤어라인 토큰(--border) → 라이트서 흰 카드 + 옅은 보더.
      borderColor: {
        "surface-3": "rgb(var(--border) / <alpha-value>)",
        "status-running": "rgb(var(--status-running) / <alpha-value>)",
        "status-idle": "rgb(var(--status-idle) / <alpha-value>)",
        "status-blocked": "rgb(var(--status-blocked) / <alpha-value>)",
        "status-offline": "rgb(var(--status-offline) / <alpha-value>)",
        "status-info": "rgb(var(--status-info) / <alpha-value>)",
      },
    },
  },
  plugins: [],
};
