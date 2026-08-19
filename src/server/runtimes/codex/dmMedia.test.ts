import { test, expect, describe } from "bun:test";
import {
  attachmentNote, decideDmMessage, dmBodyText, dmMediaRefs, downloadDmAttachments, downloadDmAttachmentsSafe,
  isImageMedia, largestPhotoVariant, MEDIA_ONLY_PROMPT,
} from "./dmMedia";
import type { StoredMedia } from "../../lib/mediaStore";

/**
 * ★1:1 로 온 첨부를 dex 가 실제로 보는가.★
 *
 * 원래 결함: 브리지가 받는 항목이 글자 하나뿐이라 ★사진만 보낸 메시지는 통째로 버려졌다.★
 * 사진에 달린 설명(caption)도 안 왔다.
 */
const saved = (o: Partial<StoredMedia>): StoredMedia => ({
  media_id: "tg_x", kind: "photo", file_id: "f", file_path: "/m/tg_x.jpg", url_path: "/media/tg_x.jpg", ...o,
} as StoredMedia);

describe("사진 크기 변형 — 장수가 아니라 화질을 고른다", () => {
  test("★같은 그림의 여러 크기 중 가장 큰 것을 고른다★", () => {
    const pick = largestPhotoVariant([
      { file_id: "s", file_size: 1000 },
      { file_id: "l", file_size: 90_000 },
      { file_id: "m", file_size: 20_000 },
    ]);
    expect(pick?.file_id).toBe("l");
  });

  test("file_size 가 없으면 넓이로 고른다 — 텔레그램이 일부 변형에만 크기를 준다", () => {
    const pick = largestPhotoVariant([
      { file_id: "s", width: 90, height: 90 },
      { file_id: "l", width: 1280, height: 960 },
    ]);
    expect(pick?.file_id).toBe("l");
  });

  test("★대조군 — 사진이 없으면 없다고 한다★ (지어내지 않는다)", () => {
    expect(largestPhotoVariant(undefined)).toBeUndefined();
    expect(largestPhotoVariant([])).toBeUndefined();
  });
});

describe("무엇을 내려받나", () => {
  test("사진 한 장은 ★한 건★ 이다 — 크기 변형마다 받지 않는다", () => {
    const refs = dmMediaRefs({ photo: [{ file_id: "s", file_size: 10 }, { file_id: "l", file_size: 900 }] });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.file_id).toBe("l");
  });

  test("사진과 문서가 같이 오면 ★둘 다★ 받는다", () => {
    const refs = dmMediaRefs({
      photo: [{ file_id: "p", file_size: 10 }],
      document: { file_id: "d", file_name: "spec.pdf", mime_type: "application/pdf" },
    });
    expect(refs.map((r) => r.kind)).toEqual(["photo", "document"]);
  });

  test("★대조군 — 첨부가 없으면 빈 목록★", () => {
    expect(dmMediaRefs({})).toHaveLength(0);
  });
});

describe("그림인가 아닌가 — 그림만 입력 아이템으로 간다", () => {
  test("photo 는 그림이다", () => {
    expect(isImageMedia({ kind: "photo", mime_type: undefined, file_name: undefined })).toBe(true);
  });
  test("★파일로 보낸 png 도 그림이다★ — 텔레그램의 '파일로 보내기' 로 오면 document 다", () => {
    expect(isImageMedia({ kind: "document", mime_type: "image/png", file_name: "shot.png" })).toBe(true);
    expect(isImageMedia({ kind: "document", mime_type: undefined, file_name: "shot.PNG" })).toBe(true);
  });
  test("★대조군 — pdf 는 그림이 아니다★ (입력 아이템으로 넣으면 codex 가 거부한다)", () => {
    expect(isImageMedia({ kind: "document", mime_type: "application/pdf", file_name: "a.pdf" })).toBe(false);
  });
});

describe("내려받기 — 한 건이 실패해도 나머지는 간다", () => {
  test("그림은 경로로, 문서는 파일로 갈린다", async () => {
    const a = await downloadDmAttachments("tok", {
      photo: [{ file_id: "p", file_size: 100 }],
      document: { file_id: "d", file_name: "spec.pdf", mime_type: "application/pdf" },
    }, {
      store: (async (_t: string, ref: { kind: string }) =>
        ref.kind === "photo"
          ? saved({ kind: "photo", file_path: "/m/shot.jpg" })
          : saved({ kind: "document", mime_type: "application/pdf", file_name: "spec.pdf", file_path: "/m/spec.pdf" })) as never,
    });
    expect(a.imagePaths).toEqual(["/m/shot.jpg"]);
    expect(a.files.map((f) => f.file_name)).toEqual(["spec.pdf"]);
    expect(a.failed).toHaveLength(0);
  });

  test("★한 건이 실패해도 나머지는 살고, 실패는 남는다★ — 조용히 없애지 않는다", async () => {
    let n = 0;
    const a = await downloadDmAttachments("tok", {
      photo: [{ file_id: "p" }],
      document: { file_id: "d", file_name: "spec.pdf", mime_type: "application/pdf" },
    }, {
      store: (async () => {
        n += 1;
        if (n === 1) throw new Error("telegram getFile failed");
        return saved({ kind: "document", mime_type: "application/pdf", file_name: "spec.pdf", file_path: "/m/spec.pdf" });
      }) as never,
    });
    expect(a.imagePaths).toHaveLength(0);
    expect(a.files).toHaveLength(1);
    expect(a.failed).toHaveLength(1);
    expect(a.failed[0]!.reason).toContain("getFile");
  });
});

describe("본문에 무엇을 적나", () => {
  test("★그림이 있으면 그렇다고 적는다★ — 설명 없이 그림만 오면 codex 가 뭘 하란 건지 모른다", () => {
    const note = attachmentNote({ imagePaths: ["/m/a.jpg"], files: [], failed: [] });
    expect(note).toContain("그림");
    expect(note).toContain("보이는 대로");
  });

  test("문서는 ★경로★ 를 적는다 — 그림과 달리 그게 유일한 통로다", () => {
    const note = attachmentNote({
      imagePaths: [], failed: [],
      files: [saved({ kind: "document", file_name: "spec.pdf", file_path: "/m/spec.pdf" })],
    });
    expect(note).toContain("/m/spec.pdf");
    expect(note).toContain("spec.pdf");
  });

  test("★실패도 적는다★ — 사람은 보냈는데 아무 말이 없으면 봤는지 못 봤는지 모른다", () => {
    const note = attachmentNote({ imagePaths: [], files: [], failed: [{ kind: "photo", reason: "20MB 초과" }] });
    expect(note).toContain("실패");
    expect(note).toContain("20MB 초과");
  });

  test("★대조군 — 첨부가 없으면 아무것도 안 붙인다★", () => {
    expect(attachmentNote({ imagePaths: [], files: [], failed: [] })).toBe("");
  });
});

describe("본문 고르기 — 사진 설명은 caption 으로 온다", () => {
  test("★caption 이 본문이 된다★ — 사진 메시지에는 text 가 없다", () => {
    expect(dmBodyText(undefined, "이 화면 뭐가 문제야?")).toBe("이 화면 뭐가 문제야?");
  });
  test("글자가 있으면 글자가 우선", () => {
    expect(dmBodyText("본문", "캡션")).toBe("본문");
  });
  test("★둘 다 없으면 없다고 한다★ — 그때만 첨부만 온 것이다", () => {
    expect(dmBodyText(undefined, undefined)).toBeUndefined();
    expect(dmBodyText("   ", "")).toBeUndefined();
  });
  test("첨부만 왔을 때 쓸 문구가 ★비어 있지 않다★ — 빈 턴이면 codex 가 아무것도 안 한다", () => {
    expect(MEDIA_ONLY_PROMPT.trim().length).toBeGreaterThan(0);
  });
});

describe("★이 메시지를 처리할 것인가★ — 원래 결함이 살던 자리", () => {
  test("★사진만 보낸 메시지도 처리한다★ — 전에는 글자가 없다고 통째로 버렸다", () => {
    const d = decideDmMessage({ photo: [{ file_id: "p", file_size: 100 }] });
    expect(d.handle, "사진만 와도 처리해야 한다").toBe(true);
    expect(d.hasMedia).toBe(true);
    expect(d.text.trim().length, "빈 턴이면 codex 가 아무것도 안 한다").toBeGreaterThan(0);
  });

  test("★사진 설명(caption)이 본문이 된다★ — 사진 메시지엔 text 가 없다", () => {
    const d = decideDmMessage({ photo: [{ file_id: "p" }], caption: "이 화면 왜 이래?" });
    expect(d.text).toBe("이 화면 왜 이래?");
  });

  test("문서만 보내도 처리한다", () => {
    expect(decideDmMessage({ document: { file_id: "d", file_name: "a.pdf" } }).handle).toBe(true);
  });

  test("글자만 오면 지금까지대로 간다", () => {
    const d = decideDmMessage({ text: "안녕" });
    expect(d).toEqual({ handle: true, text: "안녕", hasMedia: false });
  });

  test("★대조군 — 글도 첨부도 없으면 처리하지 않는다★ (아무 업데이트나 턴으로 만들지 않는다)", () => {
    expect(decideDmMessage({}).handle).toBe(false);
    expect(decideDmMessage(undefined).handle).toBe(false);
    expect(decideDmMessage({ photo: [] }).handle).toBe(false);
  });
});

describe("★안전 내려받기 — 어떤 식으로 실패해도 결과를 돌려준다★", () => {
  test("★건별 실패는 안쪽에서 잡힌다★ — 여기까지 오지 않는다(대조군)", async () => {
    const a = await downloadDmAttachmentsSafe("tok", { photo: [{ file_id: "p" }] }, {
      store: (async () => { throw new Error("망가진 응답"); }) as never,
    });
    expect(a.failed).toHaveLength(1);
    expect(a.failed[0]!.kind, "건별 실패는 그 첨부 종류로 기록된다").toBe("photo");
  });

  test("★건별 처리 바깥에서 터져도 던지지 않는다★ — 이 분기가 없으면 중간 개입이 통째로 죽는다", async () => {
    // 텔레그램이 보낸 모양이 예상과 다르면 목록을 만드는 단계에서 터진다(건별 try 밖이다).
    // 전에는 중간 개입 쪽이 이걸 .catch(() => null) 로 삼켜 ★첨부가 조용히 사라졌다.★
    const a = await downloadDmAttachmentsSafe("tok", { photo: {} as never });
    expect(a.failed, "던지지 않고 실패로 담아야 한다").toHaveLength(1);
    expect(a.failed[0]!.kind).toBe("attachment");
    expect(a.imagePaths).toHaveLength(0);
  });
});
