import { expect, test } from "bun:test";
import { runtimeReadinessFromAuth } from "./runtimeAuth";

test("RuntimeReadiness는 미설치·미인증·ready 세 상태를 secret-free 계약으로 변환한다", () => {
  expect(runtimeReadinessFromAuth({ runtime: "hermes_agent", loggedIn: false, detail: "hermes CLI 미설치(바이너리 없음)", fixHint: "install" }))
    .toMatchObject({ installed: false, authenticated: false, ready: false });
  expect(runtimeReadinessFromAuth({ runtime: "hermes_agent", loggedIn: false, detail: "hermes 미인증", fixHint: "auth" }))
    .toMatchObject({ installed: true, authenticated: false, ready: false });
  expect(runtimeReadinessFromAuth({ runtime: "hermes_agent", loggedIn: true, detail: "hermes 인증 확인됨", fixHint: "" }))
    .toMatchObject({ installed: true, authenticated: true, ready: true });
});
