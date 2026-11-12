// 권한 창이 떠 있어 넣지 못한 글을 버리지 않고 창이 닫힐 때까지 미뤘다가 다시 넣는다.
// 버스 wake 경로가 아닌 직접 주입(Slack 멘션·텔레그램 그룹 캡처)용이다 — 두 경로는 수신 행을 completed 로 넣어 dispatcher 가 깨우지 않고,
// 봉투 kind(slack·group)도 dispatcher 의 것과 달라 버스로 돌리면 답 주소가 바뀐다. 그래서 같은 규칙(재시도 예산 없이 미룬다)을 여기서 따로 적용한다.
// 글은 이미 DB 에 저장돼 있다. 여기서 미루는 것은 "세션에 넣는 일"뿐이라 서버를 다시 띄우면 대기 중이던 주입은 사라진다(감사 기록에는 남는다).
import { injectPrompt, isDeferrableInjectReason, type InjectPromptOptions, type InjectResult } from "./tmuxInject";

/** 창이 열려 있는 동안 다시 보는 간격. 버스 wake 의 permission_prompt 미루기와 같은 값. */
export const PARK_RETRY_MS = 10_000;
/** 이보다 오래 열려 있으면 포기하고 만료로 알린다(무한 대기 방지). */
export const PARK_MAX_MS = 30 * 60_000;

export interface ParkDeps {
  inject?: typeof injectPrompt;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  retryMs?: number;
  maxMs?: number;
}

export type ParkSettled = InjectResult & { expired?: boolean };

// 세션마다 한 줄로 세운다 — 먼저 미뤄진 글이 먼저 들어가고, 창이 닫힌 순간 여러 글이 동시에 붙여넣어지지 않는다.
const tails = new Map<string, Promise<void>>();

/**
 * 지금 한 번 넣어 본다. 미뤄야 하는 이유(권한 창·화면 읽기 실패)면 즉시 { parked: true } 로 돌려주고, 뒤에서 같은 세션 순서대로 다시 넣는다.
 * 뒤에서 끝나면(들어갔거나·다른 이유로 실패했거나·만료) onSettled 를 부른다. 이미 이 세션에 미뤄진 글이 있으면 앞지르지 않고 그 뒤에 선다.
 */
export async function injectOrPark(
  opts: InjectPromptOptions,
  onSettled: (r: ParkSettled) => void,
  deps: ParkDeps = {},
): Promise<InjectResult & { parked?: boolean }> {
  const inject = deps.inject ?? injectPrompt;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? PARK_RETRY_MS;
  const maxMs = deps.maxMs ?? PARK_MAX_MS;

  let reason: InjectResult["reason"] = "permission_prompt";
  if (!tails.has(opts.session)) {
    const first = await inject(opts);
    if (!isDeferrableInjectReason(first.reason)) return first;
    reason = first.reason;
  }

  const deadline = now() + maxMs;
  const prev = tails.get(opts.session) ?? Promise.resolve();
  const run = prev.then(async () => {
    for (;;) {
      await sleep(retryMs);
      const r = await inject(opts);
      if (!isDeferrableInjectReason(r.reason)) return onSettled(r);
      if (now() >= deadline) return onSettled({ ok: false, reason: r.reason, expired: true });
    }
  });
  const tail: Promise<void> = run
    .catch((e) => console.error("[injectParked] retry failed:", e instanceof Error ? e.message : e))
    .finally(() => { if (tails.get(opts.session) === tail) tails.delete(opts.session); });
  tails.set(opts.session, tail);
  return { ok: false, reason, parked: true };
}
