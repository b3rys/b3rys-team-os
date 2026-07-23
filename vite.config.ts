import { defineConfig } from "vite";

const BASE_PATH = process.env.BASE_PATH ?? "/team";

export default defineConfig({
  root: "src/web",
  base: `${BASE_PATH}/`,
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    target: "esnext",
  },
  server: {
    port: 5173,
    proxy: {
      [`${BASE_PATH}/api`]: "http://localhost:7878",
      [`${BASE_PATH}/docs`]: "http://localhost:7878",
      // exact-match(^…$) — prefix로 두면 소스 모듈 ws.ts 까지 프록시가 잡아채 503(앱 미마운트). ws 엔드포인트는 정확히 /<base>/ws.
      [`^${BASE_PATH}/ws$`]: { target: "ws://localhost:7878", ws: true },
    },
  },
});
