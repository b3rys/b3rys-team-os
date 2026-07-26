import { lstatSync, readlinkSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { HERMES_BASE_PROFILE, HERMES_ROOT } from "./paths";

const slug = /^[A-Za-z0-9_-]+$/;
const fold = (value: string): string => value.toLowerCase();

/** 설정과 실제 auth 심링크 구조를 함께 사용한다. 모호하면 모든 Hermes 프로필을 보호해 삭제를 fail-closed한다. */
export function hermesProtectedProfiles(root = `${HERMES_ROOT}/profiles`): { names: Set<string>; ambiguous: boolean } {
  const names = new Set<string>([fold(HERMES_BASE_PROFILE)]);
  const authProfiles: string[] = [];
  const sharedTargets: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return { names, ambiguous: false }; }

  for (const profile of entries) {
    if (!slug.test(profile)) continue;
    const auth = join(root, profile, "auth.json");
    try {
      const stat = lstatSync(auth);
      authProfiles.push(profile);
      if (!stat.isSymbolicLink()) continue;
      const raw = readlinkSync(auth);
      const target = isAbsolute(raw) ? raw : resolve(dirname(auth), raw);
      const targetRoot = resolve(root) + "/";
      if (!target.startsWith(targetRoot) || !target.endsWith("/auth.json")) continue;
      const targetProfile = target.slice(targetRoot.length, -"/auth.json".length);
      if (slug.test(targetProfile) && !targetProfile.includes("/")) sharedTargets.push(targetProfile);
    } catch { /* auth 없음/깨진 링크 */ }
  }

  const uniqueTargets = [...new Set(sharedTargets.map(fold))];
  if (uniqueTargets.length === 1) names.add(uniqueTargets[0]!);
  else if (uniqueTargets.length > 1) return { names, ambiguous: true };
  else {
    const uniqueAuth = [...new Set(authProfiles.map(fold))];
    if (uniqueAuth.length === 1) names.add(uniqueAuth[0]!);
    else if (uniqueAuth.length > 1) return { names, ambiguous: true };
  }
  return { names, ambiguous: false };
}

export function isHermesProfileProtected(profile: string, root?: string): boolean {
  const state = hermesProtectedProfiles(root);
  return state.ambiguous || state.names.has(fold(profile));
}

/** 모호성 fail-closed는 Hermes 런타임에만 적용한다. 다른 런타임의 멤버 id는 프로필 판정 대상이 아니다. */
export function isHermesMemberProtected(runtime: string, profile: string, root?: string): boolean {
  return runtime === "hermes_agent" && isHermesProfileProtected(profile, root);
}
