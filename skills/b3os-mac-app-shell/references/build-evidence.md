# 레시피 재현 evidence (관측 > 해석)

이 스킬의 레시피(`mac-iphone-shell` 골격 + `package-macos-app.sh`)가 **실제로 동작하는 `.app`을 만든다**는 관측 증거.

## 실제 빌드 산출물 (이 레시피로 만든 것)

- **`b3os.app`** — `mac-iphone-shell/.build/b3os.app` (2026-06-24 빌드).
  - 빌드 방법: `bash scripts/package-macos-app.sh` (= 이 스킬 §절차 7).
  - `APP_NAME=b3os.app`, `PRODUCT_NAME=B3rysMacApp`, webURL=`<dashboard-domain>/team`(테스트), ad-hoc 서명.
  - 배포본: `<dashboard-domain>/team/B3rys-unsigned-test.zip` (397KB).
- **실기 검증**: the team lead가 맥에서 실행 → "맥앱 잘 나온다 굿!!!"(2026-06-24). 창 채움(위 벌어짐/아래 잘림) 회귀 없음 확인 = viewport 3종세트가 실제로 효과.

## 재현 절차 (누구나 다시 빌드)

```
cd ~/Development/mac-iphone-shell
bash scripts/package-macos-app.sh        # → .build/b3os.app
# (서명/notarization은 references/build-sign-notarize.md)
```

## 이 evidence가 증명하는 것

- skeleton이 "존재"하는 게 아니라, 레시피를 따라 **실행되는 .app이 실제로 나오고 사람이 검증**했다(관측).
- viewport 회귀주의(3종세트)가 추상이 아니라 이 빌드에서 실측으로 확인된 함정.

## 한계 / 다음 관측

- 현재 evidence는 ad-hoc 서명 테스트 빌드 1건. **notarized 배포 빌드**는 아직 — Apple Developer ID 서명 + notarization 흐름은 다음 실전 앱에서 관측 추가 예정(`build-sign-notarize.md` 절차대로).
