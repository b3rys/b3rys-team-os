/**
 * 빌드 표식을 남긴다 — `dist/web/BUILD.json` = { commit, built_at }.
 *
 * ★왜 빌드가 남기나★: 화면(`src/web`)은 ★빌드해야 바뀌고 재시작으로는 안 바뀐다.★ 그래서 "지금 화면이
 * 어느 커밋인가" 를 아는 시점은 ★빌드하는 순간뿐★ 이다. 서버 기동 시점 커밋으로는 못 말한다
 * (2026-08-06 실측: 화면 c6f1f23d / 서버 60d39792 — 둘 다 정상인데 답이 둘이었다).
 *
 * ★왜 임시파일 → rename 인가★: `/health` 가 이 파일을 ★요청 시점에★ 읽는다. 그냥 덮어쓰면
 * 반쯤 쓰인 JSON 을 읽는 순간이 생긴다. rename 은 같은 파일시스템에서 원자적이라 ★옛 것 아니면 새 것★,
 * 둘 중 하나만 보인다.
 *
 * ★dist 안에 두는 이유★: 빌드 산출물과 ★같이 교체돼야★ 신원이 맞는다. 밖에 두면 빌드는 실패했는데
 * 표식만 새것이 되는 상태가 생긴다.
 */
import { renameSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHeadCommit, BUILD_MANIFEST } from "../src/server/lib/deployIdentity";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const distWeb = join(repoRoot, "dist", "web");

if (!existsSync(distWeb)) mkdirSync(distWeb, { recursive: true });

const commit = readHeadCommit(repoRoot);
const payload = { commit, built_at: new Date().toISOString() };

// ★같은 디렉토리에 임시로 쓰고 rename★ — 다른 파일시스템으로 건너가면 원자성이 깨진다.
const tmp = join(distWeb, `.${BUILD_MANIFEST}.tmp`);
writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
renameSync(tmp, join(distWeb, BUILD_MANIFEST));

// commit 이 null 이면 ★그대로 null 을 쓴다★ — 추측한 값을 넣지 않는다. 읽는 쪽이 멈출 수 있어야 한다.
console.log(`build manifest: commit=${commit ?? "null(모름)"} built_at=${payload.built_at}`);
