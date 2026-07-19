# b3os (b3rys team os)

**Several AIs, one team.**
_An AI team operating system for human-led multi-agent work._

> 🌐 **English** · [한국어 README](README.md)

---

> ### b3os pairs an *agent execution loop* with an *organization responsibility loop* — an **AI team operating system**.

Run several AI agents as one team: create teammates, hand them work by chatting on Telegram or Slack, and see **who owns what in a single dashboard**.

**It's not about the number of agents.** It's that instructions don't scatter — they close on one line:

> "Bill, wrap up the landing page and hand it to Steve for review."

b3os then keeps that flow **visible**.

---

## ⚡ Fastest start — the b3os skill (recommended)

**Just tell your Claude Code:**

> *"Install and run the b3os skill from this repo: github.com/b3rys/b3rys-team-os"*

Claude installs `skills/b3os/SKILL.md` into `~/.claude/skills/b3os/` and runs it, driving **clone → install → dashboard → recruiting your first teammate automatically**. You only answer the few [things only a human can do](#things-only-a-human-can-do) (bot token, activation approval).

**① Install the skill (either one)**

- **One terminal line** (no git needed): `curl -fsSL https://raw.githubusercontent.com/b3rys/b3rys-team-os/main/install-skill.sh | bash`
- **Or paste into Claude Code**: the same line above (*"Install and run the b3os skill …"*)

**② Run**

```
/reload-skills                 # once, right after installing — loads the skill you just added
"Install and run the b3os skill from this repo: github.com/b3rys/b3rys-team-os"
```

> If you installed by pasting into chat, Claude continues into running it. If the freshly-installed skill isn't loaded yet, run `/reload-skills` once and repeat the same sentence.

---

## Things only a human can do

Claude Code drives everything else conversationally. These few steps need a person, and Claude will pause and ask:

1. **Bot token** — create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and paste the token. (Claude can't log into Telegram for you.)
2. **Runtime choice** — pick who powers each teammate (see below). Claude recommends, you decide.
3. **Activation approval** — a one-key `y` to actually start a teammate's bot.
4. **First-teammate pairing** — approve the bot's DM so it will talk to you (details per runtime in the skill).

Everything else — clone, install, dashboard, wiring, recruiting — Claude does for you.

---

## 👥 Teammates & runtimes

A teammate is an AI agent with a name, role, and a **runtime** (the engine behind it). Supported runtimes:

| runtime | difficulty | notes | pairing |
|---|---|---|---|
| **claude_channel** | easy | Local Claude Code session + tmux bot. Reuses your existing Claude login (no extra subscription). | Telegram plugin pairing (6-digit code → approve) |
| **openclaw** | advanced | OpenClaw gateway/session (BYO). | dashboard **[Approve access]** (pair-approve) |
| **hermes_agent** | advanced | Hermes profile gateway (BYO). | none — activation success = ready |

> **claude** is the base and the most tested path. **openclaw** and **hermes** are advanced BYO (bring-your-own) runtimes and need their own CLI + auth setup.

---

## 🔌 Connecting channels

### Telegram (1:1)
Each teammate connects to a Telegram bot you created with @BotFather. After activation, DM the bot a quick "hi" — when it answers, you're connected. (First **claude** teammate replies with a 6-digit pairing code first; approve it, then it talks.)

### Slack *(optional — Telegram alone is enough)*
Slack connects over **Socket Mode** (no public URL). The dashboard **Settings → Slack** wizard walks you through creating the app and pasting an `App-Level Token` (`xapp-…`). This part is done by a human on the Slack site; the wizard guides each step.

You can connect **just one** of Telegram or Slack.

---

## 💬 Sending your first instruction

Once a teammate answers on Telegram, just talk to it like a coworker:

> "Take a look at the dashboard layout and suggest two options."

The teammate works, reports back, and the dashboard shows the task moving.

---

## 📡 Group room (optional — team collaboration)

To have several teammates work together in **one group chat**, add a **System OP bot** (the team router):

1. Create a **System OP bot** with @BotFather and get its token.
2. Invite that bot to your **group chat**.
3. In the dashboard **Settings ▸ System OP**: paste the **capture bot token**, enter the **group chat_id**, toggle the **router ON**.

With the router **OFF** (default), teammates don't respond in the group (decisions are shadow-logged only). Turn it **ON** for group collaboration. You can also set this up later by telling Claude Code *"how do I set up the b3os group room?"*.

---

## 🗑️ Uninstall

Tell Claude Code *"uninstall b3os"*, or run `bash uninstall.sh` in the repo. It stops the bots, removes the LaunchAgents, and cleans up (it asks before deleting data).

---

## 🔒 Safety model

- Bots only respond to approved senders (per-runtime sender gates; the first teammate is paired by a human).
- Big/irreversible actions (external sends, deletions, credentials, deploys) are announced and gated on the team lead's approval.
- Secrets (`.env`, tokens, keys) are never printed — referenced by path only.

---

## 🔀 Runtime-neutral

b3os is designed so a teammate's engine is swappable. Start on **claude** (no extra cost, best tested); add **openclaw** / **hermes** teammates as advanced options.

---

## 📄 License

[Apache License 2.0](LICENSE). b3os started as a personal open-source project by **gd.on** — use and modify freely; please keep the attribution (**gd.on**). If you use b3os in a commercial product, a "Powered by b3os" note is appreciated. The names/logos "b3os"·"b3rys" are trademarks of b3rys — code use is free, but ask before using the name/logo in a product name or branding.

> 🖥️ Developed and tested on macOS with Claude Code, so support and test coverage are narrow. This is a personal project — thanks for your understanding. Windows/Linux may be rough for now; macOS is the smoothest today.

> 🕘 Timezone: scheduled jobs (e.g. the daily task review) default to Korea time (`Asia/Seoul`). Set `B3OS_SCHEDULER_TIMEZONE` in `.env` to change it — **fixed-offset zones only** for now (e.g. `Asia/Seoul`, `Asia/Kolkata`). DST zones like `America/New_York` aren't supported yet (ignored, falls back to Korea time; boot stays safe).
