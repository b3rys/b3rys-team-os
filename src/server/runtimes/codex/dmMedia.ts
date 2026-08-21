/**
 * ★1:1 대화로 온 첨부를 dex 가 실제로 보게 한다.★
 *
 * 무엇이 문제였나 — 브리지가 받는 항목이 ★글자 하나뿐★ 이었다(TgUpdate.message.text).
 * 그래서 사진만 보낸 메시지는 통째로 버려지고, 사진에 달린 설명(caption)도 안 왔다.
 * 팀장님 관측: "dex 한테 이미지 첨부하면 못 읽는다" · "다른 팀원은 다 되는데".
 * 다른 팀원(그룹방 capture 경로)은 이미 내려받아 저장하고 있었다 — ★1:1 만 안 이어져 있었다.★
 *
 * 사진은 버려지지 않는다: 텔레그램은 ★사진 한 장을 여러 크기로★ 보낸다(photo[] = 같은 그림의 썸네일·
 * 중간·원본). 그중 가장 큰 것을 고르는 것은 ★장수를 고르는 게 아니라 화질을 고르는 것★ 이다.
 * 여러 장을 보내면 텔레그램이 ★한 장씩 따로★ 보내므로 각 메시지가 각자 처리된다.
 */
import { storeTelegramMedia, type StoredMedia, type TelegramMediaRef } from "../../lib/mediaStore";

/** 텔레그램 메시지에서 우리가 읽는 부분만. (브리지의 TgUpdate 와 같은 모양) */
export interface DmMessageMedia {
  photo?: Array<{
    file_id: string;
    file_unique_id?: string;
    file_size?: number;
    width?: number;
    height?: number;
  }>;
  document?: {
    file_id: string;
    file_unique_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
}

/**
 * 같은 그림의 여러 크기 중 ★가장 큰 것★ 을 고른다.
 * file_size 가 없는 변형이 섞여 있어 넓이로 보조 판정한다(둘 다 없으면 0 — 맨 뒤로 간다).
 */
export function largestPhotoVariant(
  photo: DmMessageMedia["photo"],
): NonNullable<DmMessageMedia["photo"]>[number] | undefined {
  return photo?.slice().sort((a, b) => {
    const as = a.file_size ?? (a.width ?? 0) * (a.height ?? 0);
    const bs = b.file_size ?? (b.width ?? 0) * (b.height ?? 0);
    return bs - as;
  })[0];
}

/** 내려받을 대상을 뽑는다 — 순수 함수라 통신 없이 잴 수 있다. */
export function dmMediaRefs(msg: DmMessageMedia, depth = 1): TelegramMediaRef[] {
  const refs: TelegramMediaRef[] = [];
  const photo = largestPhotoVariant(msg.photo);
  if (photo) {
    refs.push({
      kind: "photo",
      file_id: photo.file_id,
      file_unique_id: photo.file_unique_id,
      file_size: photo.file_size,
      width: photo.width,
      height: photo.height,
      mime_type: "image/jpeg",
    });
  }
  const doc = msg.document;
  if (doc) {
    refs.push({
      kind: "document",
      file_id: doc.file_id,
      file_unique_id: doc.file_unique_id,
      file_name: doc.file_name,
      mime_type: doc.mime_type,
      file_size: doc.file_size,
    });
  }
  // ★인용한 원문의 첨부도 함께 싣는다.★
  //   사람이 사진에 답장하면 텔레그램은 새로 친 글자만 보내고, 그 사진은 `reply_to_message` 에 있다.
  //   전에는 ★원문 텍스트만★ 실어서, 팀장님이 사진에 "이거 설명해줘" 라고 답하면 dex 는
  //   ★"텍스트는 보입니다"★ 라고 답했다 — 정작 봐야 할 그림이 안 갔다(실측).
  //   같은 파일을 다시 인용해도 저장소가 file_unique_id 로 같은 경로를 돌려주므로 중복 비용은 없다.
  //   ★깊이를 코드가 제한한다★ — 텔레그램은 인용의 인용을 안 주지만 그건 ★남의 API 의 사정★ 이다.
  //   우리 코드는 캐스팅으로 읽으므로 타입이 재귀를 못 막는다. 틀리면 대가가 ★스택 오버플로 =
  //   1:1 경로 전체 정지★ 라, 한 겹으로 잘라 둔다(빌 리뷰).
  const quoted = depth > 0 ? (msg as { reply_to_message?: DmMessageMedia }).reply_to_message : undefined;
  if (quoted) refs.push(...dmMediaRefs(quoted, depth - 1));
  return refs;
}

/** 문서가 그림인가 — .png 를 문서로 보내는 사람이 많다(텔레그램의 "파일로 보내기"). */
export function isImageMedia(m: Pick<StoredMedia, "kind" | "mime_type" | "file_name">): boolean {
  if (m.kind === "photo") return true;
  if (m.mime_type?.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif)$/i.test(m.file_name ?? "");
}

export interface DmAttachments {
  /** codex 에 ★입력 아이템★ 으로 넣을 그림 경로. 본문에 경로만 적는 것과 다르다 — 이래야 본다. */
  imagePaths: string[];
  /** 그림이 아닌 첨부(pdf·zip 등) — 본문에 경로를 적어 필요하면 열게 한다. */
  files: StoredMedia[];
  /** 내려받기에 실패한 것. ★조용히 지우지 않는다★ — 사람이 보낸 것이 사라지면 안 된다. */
  failed: Array<{ kind: string; reason: string }>;
}

/**
 * 첨부를 내려받아 로컬 경로로 만든다.
 *
 * ★한 건이 실패해도 나머지는 간다.★ 그리고 실패는 남긴다 — 사람은 보냈는데 아무 말이 없으면
 * 봤는지 못 봤는지 알 수 없다(그게 이 결함의 원래 모습이었다).
 */
export async function downloadDmAttachments(
  token: string,
  msg: DmMessageMedia,
  opts: { store?: typeof storeTelegramMedia; mediaDir?: string } = {},
): Promise<DmAttachments> {
  const store = opts.store ?? storeTelegramMedia;
  const out: DmAttachments = { imagePaths: [], files: [], failed: [] };
  for (const ref of dmMediaRefs(msg)) {
    try {
      const saved = await store(token, ref, opts.mediaDir ? { mediaDir: opts.mediaDir } : {});
      if (isImageMedia(saved)) out.imagePaths.push(saved.file_path);
      else out.files.push(saved);
    } catch (e) {
      out.failed.push({ kind: ref.kind, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/**
 * ★내려받기를 시도하되, 어떤 식으로 실패해도 결과를 돌려준다.★
 *
 * 두 경로(새 턴 · 중간 개입)가 ★같은 방어★ 를 쓰게 하려고 여기 둔다.
 * 전에는 중간 개입 쪽만 `.catch(() => null)` 이라 ★첨부가 조용히 사라졌다★ —
 * 사람은 보냈는데 못 봤다는 사실조차 안 남는다. 이 파일이 고치려는 결함과 같은 모양이다.
 * ★문을 두 개 만들었으면 그 둘도 같아야 한다.★
 */
export async function attachmentsOrFailure(load: () => Promise<DmAttachments>): Promise<DmAttachments> {
  try {
    return await load();
  } catch (e) {
    return { imagePaths: [], files: [], failed: [{ kind: "attachment", reason: e instanceof Error ? e.message : String(e) }] };
  }
}

/** 내려받기 + 위 방어. 두 경로가 ★이 한 정의★ 를 쓴다. */
export function downloadDmAttachmentsSafe(
  token: string,
  msg: DmMessageMedia,
  opts: { store?: typeof storeTelegramMedia; mediaDir?: string } = {},
): Promise<DmAttachments> {
  return attachmentsOrFailure(() => downloadDmAttachments(token, msg, opts));
}

/**
 * 첨부 사실을 본문에 덧붙인다.
 *
 * 그림은 ★입력 아이템으로 따로 들어가지만★ 본문에도 한 줄 적는다 — 안 적으면 사람이 설명 없이
 * 그림만 보냈을 때 codex 가 무엇을 해달라는 건지 모른다. 문서는 경로가 유일한 통로다.
 */
export function attachmentNote(a: DmAttachments): string {
  const lines: string[] = [];
  if (a.imagePaths.length) {
    lines.push(
      a.imagePaths.length === 1
        ? "[첨부: 그림 1장 — 위 입력으로 함께 보냈다. 보이는 대로 답하라.]"
        : `[첨부: 그림 ${a.imagePaths.length}장 — 위 입력으로 함께 보냈다. 보이는 대로 답하라.]`,
    );
  }
  for (const f of a.files) {
    lines.push(`[첨부 파일: ${f.file_name ?? f.media_id} — ${f.file_path} (필요하면 직접 열어라)]`);
  }
  for (const f of a.failed) {
    lines.push(`[첨부(${f.kind}) 내려받기 실패: ${f.reason} — 사람에게 다시 보내달라고 하라.]`);
  }
  return lines.join("\n");
}

/**
 * 첨부만 있고 글이 없을 때 쓸 본문.
 * ★빈 문자열로 두면 안 된다★ — codex 는 할 말이 없는 턴으로 받아 아무것도 안 한다.
 */
export const MEDIA_ONLY_PROMPT = "(설명 없이 첨부만 보냈다. 첨부를 보고 무엇인지 짧게 말하고, 필요한 것을 물어라.)";

/**
 * ★이 메시지를 처리할 것인가, 그리고 codex 에 무슨 말을 줄 것인가.★
 *
 * 이 판단이 원래 폴 루프 안에 `if (!text) continue` 한 줄로 있었다. 그래서
 * ★사진만 보낸 메시지가 통째로 버려졌다★ — 로그에도 안 남아 무시당한 것처럼 보였다.
 * 판단을 밖으로 빼서 시험이 지키게 한다(같은 실수를 오늘 steer 쪽에서도 했다).
 */
export function decideDmMessage(msg: {
  text?: string;
  caption?: string;
  reply_to_message?: {
    text?: string; caption?: string; from?: { username?: string; first_name?: string };
    photo?: DmMessageMedia["photo"]; document?: DmMessageMedia["document"];
  };
  photo?: DmMessageMedia["photo"];
  document?: DmMessageMedia["document"];
} | undefined): { handle: boolean; text: string; hasMedia: boolean } {
  const body = dmBodyText(msg?.text, msg?.caption);
  const hasMedia = Boolean(msg?.photo?.length || msg?.document);
  if (!body && !hasMedia) return { handle: false, text: "", hasMedia };
  // ★인용한 앞 메시지를 함께 싣는다★ — 안 실으면 "이게 모야?" 가 무엇에 대한 말인지 알 수 없다.
  return { handle: true, text: withQuotedContext(body ?? MEDIA_ONLY_PROMPT, msg?.reply_to_message), hasMedia };
}

/**
 * ★인용 답장의 원문을 본문에 붙인다.★
 *
 * 사람이 앞 메시지를 집어서 답하면 텔레그램은 ★새로 친 글자만★ 보낸다.
 * 무엇을 집었는지는 `reply_to_message` 에 따로 온다 — 그걸 안 실으면 dex 는
 * "이게 모야?" 같은 말을 ★무엇에 대한 말인지 모른 채★ 받는다(실측: 팀장님이 dex 자기 답을 인용해
 * 되물었는데 dex 는 그 연결고리를 못 봤다). 그룹방 경로는 이미 같은 형태로 싣고 있다.
 */
export function withQuotedContext(
  body: string,
  quoted: {
    text?: string; caption?: string; from?: { username?: string; first_name?: string };
    photo?: DmMessageMedia["photo"]; document?: DmMessageMedia["document"];
  } | undefined,
): string {
  const q = (quoted?.text ?? quoted?.caption ?? "").trim();
  // ★원문이 사진뿐이어도 인용은 실린다★ — 글자가 없다고 "인용 없음" 으로 처리하면
  //   그 그림이 무엇의 인용인지 사라진다(그림 자체는 dmMediaRefs 가 함께 싣는다).
  const hasMedia = Boolean(quoted?.photo?.length || quoted?.document);
  if (!q && !hasMedia) return body;
  const who = quoted?.from?.username ?? quoted?.from?.first_name;
  const mark = hasMedia ? " · 첨부 포함(아래 그림이 그 첨부다)" : "";
  return `${body}\n\n[인용한 앞 메시지${who ? ` — ${who}` : ""}${mark}]\n${q || "(글자 없이 첨부만)"}`;
}

/** 본문 = 글 또는 캡션. 둘 다 없으면 첨부만 온 것이다. */
export function dmBodyText(text: string | undefined, caption: string | undefined): string | undefined {
  const body = (text ?? caption ?? "").trim();
  return body.length ? body : undefined;
}
