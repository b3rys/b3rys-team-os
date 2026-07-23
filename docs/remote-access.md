# 원격 접근 가이드

이 가이드는 두 가지를 다룹니다.

- **맥 자체를 원격 관리** (터미널·화면): Tailscale VPN + SSH·화면 공유. → 아래 [준비](#준비) · [개발자용 SSH](#개발자용-ssh) · [일반인용 화면 공유](#일반인용-화면-공유).
- **b3os 대시보드를 다른 기기에서 열기** (여러 대 운영): Cloudflare Tunnel + b3os.app. → 아래 [b3os 대시보드를 다른 기기에서 열기](#b3os-대시보드를-다른-기기에서-열기-cloudflare-tunnel--b3osapp).

b3os를 맥미니에 설치해 두고 밖에서 접속하려면, 먼저 맥미니와 접속할 기기(맥북, 아이폰)를 같은 Tailscale VPN에 묶습니다. 그 다음 Tailscale 주소 위에서 SSH나 macOS 화면 공유로 맥미니에 접속합니다.

Tailscale은 설치하고 같은 계정으로 로그인하면 기기끼리 사설망을 만들어 주는 VPN입니다. 집 공유기 포트포워딩이나 공인 IP 설정 없이, Tailscale 안에서만 보이는 `100.x.y.z` 주소나 MagicDNS 기기 이름으로 접속합니다.

## 준비

1. 맥미니(b3os 호스트)에 Tailscale을 설치하고 로그인합니다.
2. 접속할 기기(맥북, 아이폰)에도 Tailscale을 설치하고 같은 계정으로 로그인합니다.
3. Tailscale이 연결된 상태인지 확인합니다.

맥에서 Tailscale 주소를 확인하려면 터미널에서 아래 명령을 실행합니다.

```bash
tailscale status
tailscale ip -4
```

- `tailscale status`: 같은 tailnet에 있는 기기 이름과 Tailscale IP를 봅니다.
- `tailscale ip -4`: 현재 맥의 Tailscale IPv4 주소(`100.x.y.z`)를 봅니다.
- MagicDNS가 켜져 있으면 IP 대신 Tailscale 기기 이름으로도 접속할 수 있습니다.

## 개발자용 SSH

SSH로 접속하면 터미널에서 맥미니의 파일과 프로세스를 다룰 수 있습니다.

### 1. Tailscale 연결

맥미니와 접속할 맥북에 Tailscale을 설치하고 같은 계정으로 로그인합니다.

### 2. 맥미니에서 원격 로그인 켜기

맥미니에서:

1. Apple 메뉴 -> 시스템 설정(System Settings)을 엽니다.
2. 일반(General) -> 공유(Sharing)로 이동합니다.
3. 원격 로그인(Remote Login)을 켭니다.
4. 필요한 경우 접근 허용 사용자를 제한합니다. 보통은 작업에 필요한 사용자만 허용합니다.

원격 로그인 상세 화면에는 접속에 쓸 SSH 주소가 표시됩니다. Tailscale로 접속할 때는 여기에 나온 로컬 주소 대신 맥미니의 Tailscale 기기 이름이나 `100.x.y.z` IP를 사용합니다.

### 3. 접속 기기에서 SSH 접속

접속할 맥북 터미널에서:

```bash
ssh <맥미니사용자>@<맥미니-Tailscale-호스트명-또는-100.x-IP>
```

예시:

```bash
ssh you@your-mac
ssh you@100.101.102.103
```

처음 접속할 때 호스트 키 확인 질문이 나오면, 접속 대상이 맥미니 Tailscale 주소가 맞는지 확인한 뒤 진행합니다.

### 선택: SSH 키와 별칭

자주 접속한다면 SSH 키를 등록하고 `~/.ssh/config`에 별칭을 둘 수 있습니다.

```sshconfig
Host your-mac
  HostName 100.101.102.103
  User you
  IdentityFile ~/.ssh/id_ed25519
```

그 다음부터는 아래처럼 접속합니다.

```bash
ssh your-mac
```

## 일반인용 화면 공유

화면 공유를 켜면 다른 맥에서 맥미니 화면을 직접 보고 조작할 수 있습니다. GD 실사용 흐름은 Tailscale VPN을 켠 뒤 macOS 화면 공유로 접속하는 방식입니다.

### 1. Tailscale 연결

맥미니와 접속할 기기에서 Tailscale을 켜고 같은 계정으로 로그인합니다.

### 2. 맥미니에서 화면 공유 켜기

맥미니에서:

1. Apple 메뉴 -> 시스템 설정(System Settings)을 엽니다.
2. 일반(General) -> 공유(Sharing)로 이동합니다.
3. 화면 공유(Screen Sharing)를 켭니다.
4. 필요한 경우 접근 허용 사용자를 제한합니다. 신뢰하는 사용자만 허용합니다.

화면 공유 상세 화면에는 `vnc://...` 형태의 네트워크 주소가 표시됩니다. Tailscale로 접속할 때는 맥미니의 Tailscale 기기 이름이나 `100.x.y.z` IP를 사용합니다.

### 3. 다른 맥에서 접속

방법 A: Finder에서 접속

1. Finder를 엽니다.
2. 이동(Go) -> 서버에 연결(Connect to Server)을 선택합니다.
3. 서버 주소에 아래 형식으로 입력합니다.

```text
vnc://<맥미니-Tailscale-호스트명-또는-100.x-IP>
```

예시:

```text
vnc://your-mac
vnc://100.101.102.103
```

방법 B: 화면 공유 앱에서 접속

1. macOS의 화면 공유(Screen Sharing) 앱을 엽니다.
2. 맥미니의 Tailscale 기기 이름이나 `100.x.y.z` IP를 입력합니다.
3. 맥미니 사용자 계정으로 로그인합니다.

### 4. 아이폰에서 접속

아이폰도 Tailscale 앱으로 같은 VPN에 붙을 수 있습니다. 다만 iPhone 기본 앱에는 macOS의 화면 공유 앱처럼 Mac 화면 공유(VNC)에 바로 접속하는 기본 클라이언트가 없습니다.

아이폰에서 맥미니 화면을 보려면 별도 VNC/원격 데스크톱 앱이 필요합니다. 어떤 앱과 설정을 쓸지는 별도 확인이 필요합니다.

## b3os 대시보드를 다른 기기에서 열기 (Cloudflare Tunnel + b3os.app)

위의 SSH·화면 공유는 맥 자체를 원격으로 "관리"하는 방법입니다. 이 절은 **한 맥에서 돌아가는 b3os 대시보드(웹 UI)를 다른 기기의 b3os.app(또는 브라우저)에서 여는** 방법입니다. 여러 대를 운영할 때 유용합니다 — 예: 맥미니와 맥스튜디오가 각각 자기 b3os 서버를 돌리고, 맥북에서 둘 다 원격으로 관리.

### 구성

- **서버 맥** (예: 맥스튜디오): b3os 서버가 `localhost:7878`에서 돎.
- **접속 기기** (예: 맥북): b3os.app으로 서버 맥의 대시보드를 원격으로 엶.
- 연결 통로: **Cloudflare Tunnel** — 서버 맥이 Cloudflare로 바깥 방향 터널을 뚫어, 대시보드를 `https://<도메인>`으로 노출. 포트포워딩·공인 IP 불필요.

### 왜 Cloudflare Tunnel(https)이 필요한가

b3os.app은 보안전송(App Transport Security)이 켜져 있어 **원격 주소는 https만** 허용합니다. 그래서:

- ❌ `http://100.x.y.z:7878` 같은 **평문 http(IP 직접)** 는 앱이 차단합니다. (localhost만 예외라 서버 맥 로컬에서는 http로 열림)
- ✅ `https://<도메인>` 은 열립니다. Cloudflare Tunnel이 이 https 도메인을 공짜로·안전하게 만들어 줍니다.

(사설망만 쓰고 싶으면 Tailscale + 앱 ATS 예외라는 대안도 있지만 앱 코드 수정이 필요하므로, 이 가이드는 표준인 Cloudflare Tunnel을 씁니다.)

### b3os.app 여러 개 동시 설치

라이브(dev)용 `b3os-dev.app`과 퍼블릭용 `b3os.app`은 번들 식별자가 달라(`com.b3rys.b3os.dev` / `com.b3rys.b3os`) 한 맥에 **동시에 설치·실행**됩니다. 접속 주소(Web URL) 설정도 앱마다 따로 저장되므로, 한 맥북에서 `b3os-dev.app`은 맥미니를, `b3os.app`은 맥스튜디오를 가리키게 둘 수 있습니다.

### 준비물

- 서버 맥에서 b3os 서버가 돌고 있어야 함 (`bun run start` → `http://localhost:7878/team` 열림).
- Cloudflare 계정 + Cloudflare에 등록된 도메인 1개 (예: `example.com`). 무료 플랜으로 충분.

> 표기: 아래에서 `studio.example.com`(공개할 하위 도메인), `b3os-studio`(터널 이름), `<UUID>`(터널 ID), `<사용자>`(서버 맥 로그인 계정)는 각자 실제 값으로 바꿉니다.

### 1. 서버 맥에 cloudflared 설치 (터미널)

```bash
brew install cloudflared
cloudflared --version
```

### 2. Cloudflare에 로그인 (브라우저 인증 · 사람이 1회)

```bash
cloudflared tunnel login
```

브라우저가 열리면 Cloudflare 계정으로 로그인하고 사용할 도메인을 선택합니다. 인증서가 `~/.cloudflared/cert.pem`에 저장됩니다.

### 3. 터널 생성

```bash
cloudflared tunnel create b3os-studio
```

생성되면 터널 UUID와 자격증명 파일 경로(`~/.cloudflared/<UUID>.json`)가 출력됩니다. **이 `.json`은 시크릿이므로 공유·커밋 금지.**

### 4. 도메인 → 터널 라우팅

공개할 하위 도메인을 이 터널로 연결합니다(Cloudflare DNS에 자동 등록).

```bash
cloudflared tunnel route dns b3os-studio studio.example.com
```

### 5. 터널 설정 파일 작성

서버 맥에서 `~/.cloudflared/config.yml`을 만듭니다:

```yaml
tunnel: b3os-studio
credentials-file: /Users/<사용자>/.cloudflared/<UUID>.json

ingress:
  - hostname: studio.example.com
    service: http://localhost:7878
  - service: http_status:404
```

### 6. 먼저 임시 실행으로 테스트

```bash
cloudflared tunnel run b3os-studio
```

에러 없이 `Registered tunnel connection` 로그가 뜨면 정상. (다음 단계 전에 `Ctrl-C`로 멈춰도 됨.)

### 7. 서비스로 등록 (부팅 시 자동 실행)

```bash
sudo cloudflared service install
sudo launchctl kickstart -k system/com.cloudflare.cloudflared   # 이미 돌면 재시작
```

### 8. 인증(Cloudflare Access) 붙이기 — 필수

⚠️ b3os 대시보드는 **앱 자체 로그인이 없습니다.** 도메인을 그냥 열면 누구나 접근합니다. 반드시 Cloudflare **Zero Trust → Access**에서 이 도메인에 정책을 겁니다(브라우저 UI):

1. Cloudflare 대시보드 → **Zero Trust → Access → Applications → Add an application** → **Self-hosted**.
2. Application domain = `studio.example.com`.
3. Policy 하나 추가: **Include → Emails →** 본인 이메일(허용할 사람만).
4. 저장.

이제 `studio.example.com` 접속 시 Cloudflare 로그인(이메일 인증 코드 등)을 통과해야 대시보드가 열립니다.

### 9. 검증 (서버 맥 또는 아무 브라우저)

```bash
curl -I https://studio.example.com/team
```

- Cloudflare Access 로그인으로 리다이렉트(HTTP 302)되거나 200이 나오면 터널·https 정상.
- 브라우저로 `https://studio.example.com/team`을 열어, Access 인증 뒤 대시보드가 뜨는지 확인합니다.

### 10. 접속 기기(맥북)에서 b3os.app 연결

1. 맥북에 해당 앱 설치 (퍼블릭이면 `b3os.app`).
2. 앱 실행 → `⌘,`(설정) → **Web URL** 필드에 `https://studio.example.com/team` 입력 → 저장.
3. 앱을 다시 로드하면 원격 대시보드가 뜹니다. (Access 인증 화면이 앱 웹뷰에 뜨면 로그인)

`b3os-dev.app`(→ 맥미니)과 `b3os.app`(→ 맥스튜디오)을 각각 다른 Web URL로 두면, 한 맥북에서 두 팀을 나눠 관리할 수 있습니다.

### Tailscale과의 차이 (무엇을 언제)

- **Tailscale (위 SSH·화면 공유)**: 맥 "자체"를 원격 관리(터미널·화면). 사설 VPN.
- **Cloudflare Tunnel (이 절)**: b3os "대시보드"를 https로 어디서나 열기. b3os.app이 원격에 https를 요구하므로 대시보드 원격 접속엔 이쪽이 표준.
- 둘은 병행 가능: Tailscale로 맥을 관리하고, Cloudflare Tunnel로 대시보드를 봅니다.

## 보안 원칙

- 맥미니 원격 로그인과 화면 공유는 신뢰하는 사용자에게만 허용합니다.
- 접속은 Tailscale VPN 안에서만 합니다.
- SSH나 VNC 포트를 공유기 포트포워딩으로 공용 인터넷에 열지 않습니다.
- 쓰지 않을 때는 원격 로그인이나 화면 공유를 꺼도 됩니다.
- **Cloudflare Tunnel 도메인에는 반드시 Cloudflare Access(인증)를 겁니다.** b3os 대시보드는 앱 자체 인증이 없으므로, 인증 없이 도메인을 열면 누구나 팀 데이터에 접근할 수 있습니다.
- 터널 자격증명(`~/.cloudflared/*.json`)과 터널 토큰은 시크릿입니다 — 출력·공유·git 커밋 금지.

## 참고

- Tailscale: [macOS 설치](https://tailscale.com/kb/1065/macos-variants), [MagicDNS](https://tailscale.com/kb/1081/magicdns), [CLI](https://tailscale.com/kb/1080/cli)
- Cloudflare: [Tunnel(연결 만들기)](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), [Access(인증 정책)](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- Apple: [원격 로그인](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac), [화면 공유](https://support.apple.com/guide/mac-help/turn-screen-sharing-on-or-off-mh11848/mac), [서버 연결](https://support.apple.com/guide/mac-help/connect-to-a-computer-or-server-mchlp1140/mac), [Mac 네트워크 주소 확인](https://support.apple.com/guide/mac-help/find-your-computers-name-and-network-address-mchlp1177/mac)
