import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  downloadSlackFiles,
  formatSlackFiles,
  isAllowedSlackFileUrl,
  sanitizeFileName,
  SLACK_FILE_MAX_BYTES,
  SLACK_FILE_MAX_COUNT,
} from "./slackFiles";

const URL_OK = "https://files.slack.com/files-pri/T1-F1/download/clip.mov";

function fakeFetch(handler: (url: string, token: string) => Response) {
  const calls: Array<{ url: string; token: string }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const token = String((init?.headers as Record<string, string>)?.Authorization ?? "").replace("Bearer ", "");
    calls.push({ url, token });
    return handler(url, token);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const bytes = (n: number) => new Response(new Uint8Array(n), { status: 200, headers: { "content-type": "video/quicktime" } });

describe("슬랙 첨부 파일 수신", () => {
  test("받은 파일을 키 폴더에 저장하고 경로·크기·mimetype 을 돌려준다", async () => {
    const root = mkdtempSync(join(tmpdir(), "slackfiles-"));
    const { fn } = fakeFetch(() => bytes(2048));
    const r = await downloadSlackFiles([{ name: "clip.mov", mimetype: "video/quicktime", size: 2048, url_private_download: URL_OK }], ["xoxb-a"], "C1_1.2", { fetchFn: fn, root });
    expect(r).toHaveLength(1);
    expect(r[0]!.ok).toBe(true);
    if (!r[0]!.ok) return;
    expect(r[0]!.path.startsWith(root) || r[0]!.path.includes("slackfiles-")).toBe(true);
    expect(statSync(r[0]!.path).size).toBe(2048);
    expect(r[0]!.mimetype).toBe("video/quicktime");
    expect(formatSlackFiles(r)).toContain(r[0]!.path);
  });

  test("첫 토큰이 권한 없음(로그인 HTML)이면 다음 토큰으로 받는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "slackfiles-"));
    const { fn, calls } = fakeFetch((_u, token) =>
      token === "xoxb-noscope" ? new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }) : bytes(10),
    );
    const r = await downloadSlackFiles([{ name: "a.mp4", mimetype: "video/mp4", url_private_download: URL_OK }], ["xoxb-noscope", "xoxb-scope"], "k", { fetchFn: fn, root });
    expect(r[0]!.ok).toBe(true);
    expect(calls.map((c) => c.token)).toEqual(["xoxb-noscope", "xoxb-scope"]);
  });

  test("모든 토큰이 권한 없음이면 실패 이유를 남기고 파일을 만들지 않는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "slackfiles-"));
    const { fn } = fakeFetch(() => new Response("<html/>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
    const r = await downloadSlackFiles([{ name: "a.mp4", mimetype: "video/mp4", url_private_download: URL_OK }], ["t1"], "k", { fetchFn: fn, root });
    expect(r[0]).toEqual({ ok: false, name: "a.mp4", reason: "권한 없음(files:read) 또는 HTML 응답" });
    expect(readdirSync(join(root, "k"))).toHaveLength(0);
    expect(formatSlackFiles(r)).toContain("받지 못함: 권한 없음(files:read)");
  });

  test("files.slack.com 이 아닌 주소에는 토큰을 보내지 않는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "slackfiles-"));
    const { fn, calls } = fakeFetch(() => bytes(1));
    const r = await downloadSlackFiles(
      [
        { name: "x", url_private_download: "https://evil.example/files.slack.com/x" },
        { name: "y", url_private_download: "http://files.slack.com/x" },
        { name: "z", url_private_download: "https://files.slack.com.evil.example/x" },
      ],
      ["xoxb-secret"],
      "k",
      { fetchFn: fn, root },
    );
    expect(calls).toHaveLength(0);
    expect(r.every((x) => !x.ok)).toBe(true);
    expect(isAllowedSlackFileUrl(URL_OK)).toBe(true);
  });

  test("크기 상한을 넘는 파일은 받지 않는다(신고 크기·실제 크기 둘 다)", async () => {
    const root = mkdtempSync(join(tmpdir(), "slackfiles-"));
    const { fn, calls } = fakeFetch(() => bytes(1));
    const r = await downloadSlackFiles([{ name: "big.mov", size: SLACK_FILE_MAX_BYTES + 1, url_private_download: URL_OK }], ["t"], "k", { fetchFn: fn, root });
    expect(r[0]!.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("한 메시지의 파일 수를 제한한다", async () => {
    const root = mkdtempSync(join(tmpdir(), "slackfiles-"));
    const { fn } = fakeFetch(() => bytes(1));
    const files = Array.from({ length: SLACK_FILE_MAX_COUNT + 2 }, (_, i) => ({ name: `f${i}`, url_private_download: URL_OK }));
    const r = await downloadSlackFiles(files, ["t"], "k", { fetchFn: fn, root });
    expect(r.filter((x) => x.ok)).toHaveLength(SLACK_FILE_MAX_COUNT);
    expect(r.filter((x) => !x.ok)).toHaveLength(2);
  });

  test("파일명·키로 저장 폴더 밖에 쓰지 못한다", async () => {
    const root = mkdtempSync(join(tmpdir(), "slackfiles-"));
    const { fn } = fakeFetch(() => bytes(3));
    const r = await downloadSlackFiles([{ name: "../../../etc/passwd", url_private_download: URL_OK }], ["t"], "../../escape", { fetchFn: fn, root });
    expect(r[0]!.ok).toBe(true);
    if (!r[0]!.ok) return;
    expect(r[0]!.path.startsWith(join(root.startsWith("/var") ? "/private" + root : root))).toBe(true);
    expect(existsSync(join(root, "..", "escape"))).toBe(false);
    expect(readFileSync(r[0]!.path).byteLength).toBe(3);
  });

  test("sanitizeFileName 은 경로·제어문자·앞 점을 지우고 한글은 남긴다", () => {
    expect(sanitizeFileName("../a/b/영상 교체.mov")).toBe("영상 교체.mov");
    expect(sanitizeFileName(".hidden")).toBe("hidden");
    expect(sanitizeFileName("a\u0000b;rm -rf.mp4")).toBe("ab_rm -rf.mp4");
    expect(sanitizeFileName("")).toBe("file");
  });
});

describe("슬랙 첨부 파일 수신 — 적대적 경우", () => {
  const streamOf = (chunks: number, chunkSize: number, headers: Record<string, string> = {}) => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= chunks) return c.close();
        pulled++;
        c.enqueue(new Uint8Array(chunkSize));
      },
    });
    return { res: new Response(body, { status: 200, headers: { "content-type": "video/mp4", ...headers } }), pulled: () => pulled };
  };

  test("크기 신고 없이 상한을 넘는 스트림은 상한 근처에서 멈추고 파일을 남기지 않는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "slackfiles-"));
    const s = streamOf(100, 1024);
    const fetchFn = (async () => s.res) as unknown as typeof fetch;
    const r = await downloadSlackFiles([{ name: "big.mp4", url_private_download: URL_OK }], ["t"], "k", { fetchFn, root, maxBytes: 4096 });
    expect(r[0]!.ok).toBe(false);
    expect(s.pulled()).toBeLessThan(10);
    expect(readdirSync(join(root, "k"))).toHaveLength(0);
  });

  test("Content-Length 가 상한을 넘으면 본문을 읽지 않는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "slackfiles-"));
    const s = streamOf(100, 1024, { "content-length": String(100 * 1024) });
    const fetchFn = (async () => s.res) as unknown as typeof fetch;
    const r = await downloadSlackFiles([{ name: "big.mp4", url_private_download: URL_OK }], ["t"], "k", { fetchFn, root, maxBytes: 4096 });
    expect(r[0]!.ok).toBe(false);
    expect(s.pulled()).toBeLessThanOrEqual(1);
  });

  test("저장 자리에 미리 놓인 링크를 따라가 밖의 파일을 덮어쓰지 않는다", async () => {
    const { symlinkSync, writeFileSync: wf, mkdirSync: md } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "slackfiles-"));
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "victim.txt");
    wf(outside, "ORIGINAL");
    md(join(root, "k"), { recursive: true });
    symlinkSync(outside, join(root, "k", "1-clip.mov"));
    const fetchFn = (async () => new Response("OVERWRITTEN", { status: 200, headers: { "content-type": "video/quicktime" } })) as unknown as typeof fetch;
    const r = await downloadSlackFiles([{ name: "clip.mov", url_private_download: URL_OK }], ["t"], "k", { fetchFn, root });
    expect(r[0]!.ok).toBe(false);
    expect(readFileSync(outside, "utf-8")).toBe("ORIGINAL");
  });

  test("text/html 응답은 첨부가 HTML 이고 크기가 같아도 성공으로 보지 않는다(로그인 페이지와 구별 불가)", async () => {
    const root = mkdtempSync(join(tmpdir(), "slackfiles-"));
    const login = "<html><body>Sign in to Slack</body></html>";
    const fetchFn = (async () => new Response(login, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const r = await downloadSlackFiles([{ name: "page.html", mimetype: "text/html", size: login.length, url_private_download: URL_OK }], ["t"], "k", { fetchFn, root });
    expect(r[0]!.ok).toBe(false);
    expect(readdirSync(join(root, "k"))).toHaveLength(0);
  });
});
