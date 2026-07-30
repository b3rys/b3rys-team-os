# 대시보드를 도메인으로 열기

대시보드를 `dash.example.com` 같은 주소로 여는 방법입니다.

---

## 먼저 읽으세요

b3os에는 앱 레벨 로그인이 없습니다. 계정도 비밀번호도 없습니다.
**"요청이 로컬에서 왔는가" 하나만 보고 팀리드로 인정합니다.**

아래 설정을 하면 **그 주소로 들어온 요청은 전부 팀리드**가 됩니다.
사람을 구분하지 않으므로 감사 로그의 행위자도 전원 같은 이름입니다.

> **내부망 주소이거나, 앞에 로그인 관문이 있는 주소만 등록하세요.**
> 관문은 Cloudflare Access, 사내 SSO 등 무엇이든 됩니다.
> 관문 없이 이 설정만 하면 주소를 아는 사람 누구나 팀리드가 됩니다.

**아래가 전부 예(Yes)일 때만 진행하세요.**

- [ ] 그 주소는 로그인 관문(Access·SSO 등) 뒤에 있다
- [ ] 관문을 통과할 수 있는 사람이 전부 팀리드여도 괜찮다
- [ ] 서버는 로컬(`127.0.0.1`)에만 열려 있다 (`TEAM_BIND` 를 바꾸지 않았다)

---

## 왜 그냥은 안 되나

터널·리버스 프록시는 기본적으로 **사용자가 친 주소를 그대로** 서버에 넘깁니다.

```
브라우저 ──  Host: dash.example.com  ──▶ 터널 ──  Host: dash.example.com  ──▶ b3os
```

b3os는 이 `Host` 를 보고 "로컬이 아니다" 라고 판단해서 막습니다.
막히면 **"등록되지 않은 주소입니다"** 라는 안내 페이지가 뜹니다.

푸는 방법은 두 가지입니다. **①을 권합니다.** b3os 설정을 바꾸지 않고, 주소를 늘려도 서버를 다시 띄울 필요가 없습니다.

---

## 방법 ① 터널이 Host를 로컬로 바꾸게 한다 (권장)

터널이 서버로 넘길 때만 `Host` 를 `127.0.0.1` 로 바꿉니다. 브라우저 주소창은 그대로입니다.

```
브라우저 ──  Host: dash.example.com  ──▶ 터널 ──  Host: 127.0.0.1  ──▶ b3os
                                                         ▲
                                            여기만 바꾼다 (터널 설정)
```

**Cloudflare Tunnel:** 찾을 것은 그 hostname 의 **HTTP Host Header** 칸 하나입니다.
거기에 `127.0.0.1` 을 넣고 저장합니다.

Cloudflare **Zero Trust** 대시보드에서 들어갑니다. UI 개편에 따라 메뉴 이름이 다를 수 있어
두 경로를 적습니다 — 둘 다 같은 화면입니다.

```
Networks → Connectors → Cloudflare Tunnels → 터널 Edit
  → Published application routes → 애플리케이션 Edit
  → Additional application settings → HTTP Host Header

Networks → Tunnels & Mesh → 터널 선택
  → Published application routes → hostname 줄
  → Origin request and connection settings → HTTP Host Header
```

둘 다 안 보이면 **터널 → 그 hostname 의 설정 → 고급/추가 설정** 안에서 `HTTP Host Header` 를 찾습니다.

> **Service 는 건드리지 마세요.** `http://localhost:7878` 그대로 둡니다.
> 바꾸는 건 **HTTP Host Header** 한 칸뿐입니다.

다른 터널·프록시를 쓴다면 같은 뜻의 설정을 찾으면 됩니다.
nginx 는 `proxy_set_header Host 127.0.0.1;`, Caddy 는 `header_up Host 127.0.0.1` 입니다.

---

## 방법 ② b3os에 주소를 등록한다

터널 설정을 만질 수 없을 때 씁니다. `.env` 에 주소를 적습니다.

```bash
TEAM_TRUSTED_DASHBOARD_HOSTS=dash.example.com
```

여러 개는 쉼표로, 하위 주소 전체는 `*.` 로 적습니다.

```bash
TEAM_TRUSTED_DASHBOARD_HOSTS=dash.example.com,*.internal.example.com
```

**규칙 세 가지**

| | |
|---|---|
| `*.example.com` 은 **하위 주소만** | `example.com` 자체도 열려면 따로 적어야 합니다 |
| 접미사만 같은 주소는 안 걸립니다 | `evilexample.com`, `example.com.attacker.net` 은 막힙니다 |
| **`TEAM_BIND` 가 루프백일 때만 적용됩니다** | `TEAM_BIND=0.0.0.0` 처럼 서버를 직접 열어뒀다면 이 설정은 **무시되고** 경고 로그가 남습니다 |

마지막 줄이 안전장치입니다. 직접 열린 서버에서 `Host` 만 보고 권한을 주면
**누구나 그 Host 를 지어내 보낼 수 있어** 무인증 팀리드가 되기 때문입니다.

바꿨으면 서버를 다시 띄웁니다.

```bash
bun run service restart   # launchd 로 등록했다면
# 또는
bun run start
```

---

## 설정한 뒤 — 실제로 열리는지 확인하세요

설정을 바꾼 것과 실제로 적용된 것은 다릅니다. **반드시 확인하세요.**

### 브라우저로 — 두 방법 모두 이걸로 확인합니다

1. 그 주소로 대시보드를 엽니다
2. **Doc → Reports** 로 가서 태그를 하나 만들어 봅니다
3. 만들어지면 된 것입니다

**"등록되지 않은 주소입니다" 페이지가 그대로 뜬다면 아직 적용되지 않은 것입니다.**

이게 끝까지 확인하는 유일한 방법입니다. 요청이 앞단 관문·터널을 다 거쳐 서버에 닿기 때문입니다.

### 터미널로 — **방법 ② 만** 확인됩니다

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: dash.example.com" http://127.0.0.1:7878/team/
# 200 이면 그 주소가 서버에 등록된 것, 403 이면 아직입니다
```

이 요청은 **서버로 직접 갑니다.** 터널을 거치지 않으므로 **방법 ① 은 판별하지 못합니다** —
①을 제대로 해뒀어도 이 명령은 403 이 나옵니다. ①을 썼다면 위 브라우저 확인을 쓰세요.

도메인으로 보내는 `curl` 도 권하지 않습니다. 앞단에 로그인 관문이 있으면 대시보드가 아니라
관문의 로그인 페이지가 돌아오고, 그 응답 코드로는 아무것도 판별할 수 없습니다.

---

## 안 될 때

| 증상 | 볼 곳 |
|---|---|
| 안내 페이지가 계속 뜬다 | ①을 썼다면 터널의 **HTTP Host Header** 가 저장됐는지. ②를 썼다면 서버를 다시 띄웠는지 |
| ② 를 적었는데 무시된다 | `TEAM_BIND` 가 루프백인지. 아니면 서버 로그에 경고가 남아 있습니다 |
| 화면은 뜨는데 저장·삭제가 안 된다 | 브라우저에서 태그를 하나 만들어 보세요. 안내 페이지가 뜨면 주소가 아직 통과하지 못한 것입니다 |
| `curl` 은 403 인데 브라우저는 된다 | 방법 ①을 쓴 경우 정상입니다. `curl` 은 터널을 거치지 않아 ①을 판별하지 못합니다 |
| 주소는 맞는데 막힌다 | 대소문자·포트는 상관없지만, 오타와 `*.` 규칙(하위 주소만)을 다시 보세요 |

---

## 같이 볼 것

- [원격 접근 가이드](remote-access.md) — 머신 자체에 붙는 법(Tailscale VPN + SSH·화면 공유)
- `.env.example` 의 `TEAM_TRUSTED_DASHBOARD_HOSTS` 항목
