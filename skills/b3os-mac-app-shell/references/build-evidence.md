# 레시피 재현 evidence (관측 > 해석)

이 스킬의 레시피(골격 저장소 `mac-iphone-shell` + 그 안의 `package-macos-app.sh`)가 **실제로 동작하는 `.app`을 만든다**는 관측 증거.
★골격은 b3rys 내부 비공개 저장소이며 이 저장소에 포함되어 있지 않다.★

## 실제 빌드 산출물 (이 레시피로 만든 것)

- **`b3os.app`** — 골격 저장소의 `.build/b3os.app` (2026-06-24 빌드).
  - 빌드 방법: `bash scripts/package-macos-app.sh` (= 이 스킬 §절차 7).
  - `APP_NAME=b3os.app`, `PRODUCT_NAME=B3rysMacApp`, webURL=`<dashboard-domain>/team`(테스트), ad-hoc 서명.
  - 배포본: `<dashboard-domain>/team/B3rys-unsigned-test.zip` (397KB).
- **실기 검증**: the team lead가 맥에서 실행 → "맥앱 잘 나온다 굿!!!"(2026-06-24). 창 채움(위 벌어짐/아래 잘림) 회귀 없음 확인 = viewport 3종세트가 실제로 효과.

## 재현 절차 (골격 저장소 접근 권한이 있는 팀원)

★골격 `mac-iphone-shell`은 내부 비공개 저장소이며 이 저장소에 포함되어 있지 않다.★ 먼저 clone한 뒤, 그 위치를 `$SHELL_SKELETON`으로 두고 실행한다.

```
cd "$SHELL_SKELETON"                     # 골격을 clone 한 경로
bash scripts/package-macos-app.sh        # → .build/b3os.app
# (서명/notarization은 references/build-sign-notarize.md)
```

## 이 evidence가 증명하는 것

- skeleton이 "존재"하는 게 아니라, 레시피를 따라 **실행되는 .app이 실제로 나오고 사람이 검증**했다(관측).
- viewport 회귀주의(3종세트)가 추상이 아니라 이 빌드에서 실측으로 확인된 함정.

## 한계 / 다음 관측

- 현재 evidence는 ad-hoc 서명 테스트 빌드 1건. **notarized 배포 빌드**는 아직 — Apple Developer ID 서명 + notarization 흐름은 다음 실전 앱에서 관측 추가 예정(`build-sign-notarize.md` 절차대로).
