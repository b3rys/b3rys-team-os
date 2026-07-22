# 원격 접근 가이드

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
ssh youruser@your-mac
ssh youruser@100.101.102.103
```

처음 접속할 때 호스트 키 확인 질문이 나오면, 접속 대상이 맥미니 Tailscale 주소가 맞는지 확인한 뒤 진행합니다.

### 선택: SSH 키와 별칭

자주 접속한다면 SSH 키를 등록하고 `~/.ssh/config`에 별칭을 둘 수 있습니다.

```sshconfig
Host your-mac
  HostName 100.101.102.103
  User youruser
  IdentityFile ~/.ssh/id_ed25519
```

그 다음부터는 아래처럼 접속합니다.

```bash
ssh your-mac
```

## 일반인용 화면 공유

화면 공유를 켜면 다른 맥에서 맥미니 화면을 직접 보고 조작할 수 있습니다. OWNER 실사용 흐름은 Tailscale VPN을 켠 뒤 macOS 화면 공유로 접속하는 방식입니다.

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

## 보안 원칙

- 맥미니 원격 로그인과 화면 공유는 신뢰하는 사용자에게만 허용합니다.
- 접속은 Tailscale VPN 안에서만 합니다.
- SSH나 VNC 포트를 공유기 포트포워딩으로 공용 인터넷에 열지 않습니다.
- 쓰지 않을 때는 원격 로그인이나 화면 공유를 꺼도 됩니다.

## 참고

- Tailscale: [macOS 설치](https://tailscale.com/kb/1065/macos-variants), [MagicDNS](https://tailscale.com/kb/1081/magicdns), [CLI](https://tailscale.com/kb/1080/cli)
- Apple: [원격 로그인](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac), [화면 공유](https://support.apple.com/guide/mac-help/turn-screen-sharing-on-or-off-mh11848/mac), [서버 연결](https://support.apple.com/guide/mac-help/connect-to-a-computer-or-server-mchlp1140/mac), [Mac 네트워크 주소 확인](https://support.apple.com/guide/mac-help/find-your-computers-name-and-network-address-mchlp1177/mac)
