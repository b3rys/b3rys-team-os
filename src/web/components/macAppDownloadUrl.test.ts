import { describe, expect, it } from "bun:test";
import { MAC_APP_DOWNLOAD_TAG, MAC_APP_DOWNLOAD_URL } from "./MetricsBar";

// 2026-07-28 라이브 장애의 회귀 가드.
// 대시보드 상단 b3os.app 링크가 `releases/latest/download/` 였고, v0.5.1 태그가 앱 자산 없이
// 올라가면서 latest 가 빈 릴리스를 가리켜 404 가 됐다. URL 은 멀쩡해 보였고 아무 경고도 없었다.
// 외부 사용자가 신고할 때까지 하루가 걸렸다.
describe("b3os.app 다운로드 링크", () => {
  it("`latest` 를 쓰지 않는다 — 자산 없는 릴리스를 가리키면 조용히 404 가 된다", () => {
    expect(MAC_APP_DOWNLOAD_URL).not.toContain("/releases/latest/");
  });

  it("자산이 붙어 있는 태그를 고정해서 가리킨다", () => {
    expect(MAC_APP_DOWNLOAD_TAG).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(MAC_APP_DOWNLOAD_URL).toBe(
      `https://github.com/b3rys/b3rys-team-os/releases/download/${MAC_APP_DOWNLOAD_TAG}/b3os.app.zip`,
    );
  });
});
