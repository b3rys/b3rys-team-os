/** 사진만 보낸 DM과 caption도 수신한다. Telegram photo 배열은 같은 사진의 해상도별 변형이므로 가장 큰 하나를 고르는 것은 장수 제한이 아니다.
 * 여러 장은 메시지별로 전달되어 각각 처리한다. */
import { storeTelegramMedia, type StoredMedia, type TelegramMediaRef } from "../../lib/mediaStore";
import { TELEGRAM_API_BASE, channelFromEnv } from "../../lib/memberChannel";

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
 * 같은 그림의 여러 크기 중 가장 큰 것 을 고른다.
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
  // 인용한 사진은 reply_to_message에 있으므로 함께 수집한다. 같은 파일은 file_unique_id로 재사용한다.
  // 벤더가 중첩 인용을 주지 않더라도 캐스팅된 입력의 재귀를 타입이 막지 못하므로 한 겹으로 제한해 스택 초과를 방지한다.
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
  /** codex 에 입력 아이템 으로 넣을 그림 경로. 본문에 경로만 적는 것과 다르다 — 이래야 본다. */
  imagePaths: string[];
  /** 그림이 아닌 첨부(pdf·zip 등) — 본문에 경로를 적어 필요하면 열게 한다. */
  files: StoredMedia[];
  /** 내려받기에 실패한 것. 조용히 지우지 않는다 — 사람이 보낸 것이 사라지면 안 된다. */
  failed: Array<{ kind: string; reason: string }>;
}

/** 첨부 한 건의 실패가 다른 첨부를 막지 않도록 격리하며, 실패를 기록해 사람이 보낸 자료가 조용히 사라지지 않게 한다. */
export async function downloadDmAttachments(
  token: string,
  msg: DmMessageMedia,
  opts: { store?: typeof storeTelegramMedia; mediaDir?: string; apiBase?: string } = {},
): Promise<DmAttachments> {
  const store = opts.store ?? storeTelegramMedia;
  // 팀원 채널(b3chat 등)이면 그 서버에서 받는다. 텔레그램이면 옵션을 지금과 똑같이 넘긴다.
  const apiBase = opts.apiBase ?? channelFromEnv().apiBase;
  const storeOpts = {
    ...(opts.mediaDir ? { mediaDir: opts.mediaDir } : {}),
    ...(apiBase !== TELEGRAM_API_BASE ? { apiBase } : {}),
  };
  const out: DmAttachments = { imagePaths: [], files: [], failed: [] };
  for (const ref of dmMediaRefs(msg)) {
    try {
      const saved = await store(token, ref, storeOpts);
      if (isImageMedia(saved)) out.imagePaths.push(saved.file_path);
      else out.files.push(saved);
    } catch (e) {
      out.failed.push({ kind: ref.kind, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** 새 턴과 중간 개입의 첨부 실패 표현을 공유한다. 예외도 결과로 변환해야 전송한 첨부가 말없이 사라지지 않는다. */
export async function attachmentsOrFailure(load: () => Promise<DmAttachments>): Promise<DmAttachments> {
  try {
    return await load();
  } catch (e) {
    return { imagePaths: [], files: [], failed: [{ kind: "attachment", reason: e instanceof Error ? e.message : String(e) }] };
  }
}

/** 내려받기 + 위 방어. 두 경로가 이 한 정의 를 쓴다. */
export function downloadDmAttachmentsSafe(
  token: string,
  msg: DmMessageMedia,
  opts: { store?: typeof storeTelegramMedia; mediaDir?: string; apiBase?: string } = {},
): Promise<DmAttachments> {
  return attachmentsOrFailure(() => downloadDmAttachments(token, msg, opts));
}

/** 이미지는 별도 입력 아이템이지만 설명 없는 첨부의 의도를 알리도록 본문에도 표시한다. 문서는 경로가 모델에 전달되는 유일한 통로다. */
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
 * 빈 문자열로 두면 안 된다 — codex 는 할 말이 없는 턴으로 받아 아무것도 안 한다.
 */
export const MEDIA_ONLY_PROMPT = "(설명 없이 첨부만 보냈다. 첨부를 보고 무엇인지 짧게 말하고, 필요한 것을 물어라.)";

/** 본문이 없어도 첨부가 있으면 처리한다. 순수 함수로 분리해 폴 루프에서 사진 메시지를 건너뛰지 않는지 검증한다. */
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
  // 인용한 원문의 첨부도 "첨부 있음" 으로 센다.
  //   `dmMediaRefs` 가 인용 첨부를 모으게 고쳤는데도 라이브에서 그림이 안 갔다 — 부르는 쪽이
  //   이 값으로 내려받기를 걸지 말지 정하기 때문 이다(`bridge.ts` 의 `fetchAttachments`).
  //   즉 모으는 코드는 고쳤는데 그 앞의 문이 닫혀 있었다. 본문에는 "첨부 포함" 이 찍히는데
  //   파일은 안 받아지는 상태가 그것이다(실측).
  const quoted = msg?.reply_to_message;
  const hasMedia = Boolean(
    msg?.photo?.length || msg?.document || quoted?.photo?.length || quoted?.document,
  );
  if (!body && !hasMedia) return { handle: false, text: "", hasMedia };
  // 인용한 앞 메시지를 함께 싣는다 — 안 실으면 "이게 모야?" 가 무엇에 대한 말인지 알 수 없다.
  return { handle: true, text: withQuotedContext(body ?? MEDIA_ONLY_PROMPT, msg?.reply_to_message), hasMedia };
}

/** 인용 원문은 새 text에 포함되지 않고 reply_to_message에 있으므로 본문에 함께 실어 지시 대상의 맥락을 보존한다. */
export function withQuotedContext(
  body: string,
  quoted: {
    text?: string; caption?: string; from?: { username?: string; first_name?: string };
    photo?: DmMessageMedia["photo"]; document?: DmMessageMedia["document"];
  } | undefined,
): string {
  const q = (quoted?.text ?? quoted?.caption ?? "").trim();
  // 원문이 사진뿐이어도 인용은 실린다 — 글자가 없다고 "인용 없음" 으로 처리하면
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
