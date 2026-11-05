# Claude Observability Desktop

A Windows desktop skin for **[disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability)** — watch every Claude Code session on your PC in one window.

This repository does **not** contain the original project. The installer downloads it from the original author's GitHub (pinned to a tested commit) and applies the changes kept here. All credit for the original observability system goes to [disler](https://github.com/disler).

[한국어 안내는 아래에 있습니다](#한국어)

![Three Claude Code sessions in one window: combined activity on top, one lane per session below](docs/screenshot-overview.png)

<sub>Sample data: three sessions on two machines. Each bar is one second; icons show the tools used (❌ = failed call).</sub>

## What it changes

- **Own window**: the dashboard opens in an Edge app-mode window (no address bar). The event server runs inside it; close the window and everything stops.
- **No Python**: hooks are sent by a small Bun script instead of `uv` + Python, and run asynchronously, so Claude Code never waits on them.
- **Per-session lanes, automatic**: every active session gets its own graph row; the combined "Live Activity Pulse" opens only while nothing is running.
- **Cleaner look**: thin header, compact chips, rounded bars stacked by session color, tool icons stacked on light badges from the bottom of each bar (readable on dark themes), a colorblind-checked session palette, dark theme by default.
- **Clear follow mode**: a "Live" pill while the event list follows new events, "Latest" once you scroll away (click to jump back).

![Default view while sessions are running: one lane per session](docs/screenshot-lanes.png)

## Requirements

Windows 10/11, [Git](https://git-scm.com/download/win), and [Bun](https://bun.sh) (the installer installs Bun with `npm` if Node.js is present). Microsoft Edge is used for the window (falls back to your default browser).

## Install

```powershell
git clone <this repository>
cd claude-observability-desktop
powershell -ExecutionPolicy Bypass -File install.ps1
```

Options: `-InstallDir <path>` (default `%USERPROFILE%\claude-observability`), `-SourceApp <name>` (label shown for this PC, default the computer name).

The installer:
1. clones the original project into the install folder and checks out the tested commit,
2. applies `patches/observability-desktop.patch` and copies `desktop/` to `apps/desktop`,
3. runs `bun install` for the server and client,
4. runs `bun apps/desktop/main.ts --install`, which builds the dashboard, adds 12 async hooks to `~/.claude/settings.json` (a timestamped backup is kept; older hooks from the original Python sender are replaced) and creates **Claude Observability** shortcuts on the desktop and in the Start menu.

## Use

Open **Claude Observability**. Sessions appear as soon as Claude Code does anything. Events are recorded **only while the window is open** — minimize it to keep recording. Data lives in `%LOCALAPPDATA%\ClaudeObservability`.

## Uninstall

```powershell
bun "%USERPROFILE%\claude-observability\apps\desktop\main.ts" --uninstall
```

Removes the hooks and shortcuts (history in `%LOCALAPPDATA%\ClaudeObservability` is kept; delete that folder to remove it), then delete the install folder.

## Repository layout

| Path | Content |
|---|---|
| `install.ps1` | Installer |
| `patches/observability-desktop.patch` | Changes to the original client and server |
| `desktop/main.ts` | Window launcher, hook sender, install/uninstall |
| `desktop/assets/` | App icon (PNG and its SVG source page) |

---

## 한국어

이 PC에서 도는 모든 Claude Code 세션을 창 하나에서 실시간으로 보는 도구입니다. **[disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability)** 를 Windows 데스크톱용으로 바꾼 것입니다.

이 저장소에는 **원본 코드가 들어 있지 않습니다**. 설치 스크립트가 원작자의 GitHub에서 원본을 받아(시험한 버전에 고정), 여기 있는 변경분만 입힙니다. 원본 관측 시스템의 공은 모두 [disler](https://github.com/disler)에게 있습니다.

### 바뀐 점

- **자체 창**: 대시보드가 Edge 앱 모드 창(주소창 없음)으로 뜹니다. 이벤트 서버가 창과 함께 돌고, 창을 닫으면 모두 종료됩니다.
- **Python 불필요**: 훅을 `uv` + Python 대신 Bun 스크립트로 보내고, 백그라운드로 돌아 Claude Code를 기다리게 하지 않습니다.
- **세션별 그래프 자동 표시**: 활동 중인 세션마다 그래프 한 줄이 생기고, 전체 그래프(Live Activity Pulse)는 아무 세션도 돌지 않을 때만 펼쳐집니다.
- **깔끔한 디자인**: 얇은 상단 줄, 작은 칩, 세션 색으로 쌓은 둥근 막대, 막대 아래쪽부터 흰 배지 위에 쌓은 도구 아이콘(다크 테마에서도 잘 보임), 색약을 고려한 세션 색, 기본 다크 테마.
- **알기 쉬운 자동 스크롤**: 이벤트 목록이 새 이벤트를 따라가는 동안은 "Live", 위로 스크롤하면 "Latest"로 바뀝니다(누르면 최신으로 이동).

화면 예시는 위 영어 안내의 스크린샷을 보세요(예시 데이터: 두 대의 PC에서 도는 세션 3개).

### 필요한 것

Windows 10/11, [Git](https://git-scm.com/download/win), [Bun](https://bun.sh)(Node.js가 있으면 설치 스크립트가 `npm`으로 Bun을 설치). 창은 Microsoft Edge로 띄웁니다(없으면 기본 브라우저).

### 설치

```powershell
git clone <이 저장소>
cd claude-observability-desktop
powershell -ExecutionPolicy Bypass -File install.ps1
```

옵션: `-InstallDir <경로>`(기본 `%USERPROFILE%\claude-observability`), `-SourceApp <이름>`(대시보드에 표시할 이 PC 이름, 기본은 컴퓨터 이름).

설치 스크립트가 하는 일:
1. 원본 프로젝트를 설치 폴더에 받고 시험한 커밋으로 맞춥니다.
2. `patches/observability-desktop.patch`를 적용하고 `desktop/`을 `apps/desktop`으로 복사합니다.
3. 서버와 화면의 패키지를 받습니다(`bun install`).
4. `bun apps/desktop/main.ts --install`을 실행합니다. 화면을 빌드하고, `~/.claude/settings.json`에 백그라운드 훅 12개를 넣고(시각이 붙은 백업을 남기며, 원본 Python 훅은 교체), 바탕화면과 시작 메뉴에 **Claude Observability** 바로가기를 만듭니다.

### 사용

**Claude Observability**를 엽니다. Claude Code가 무언가를 하는 순간 세션이 나타납니다. 이벤트는 **창이 열려 있는 동안만** 기록됩니다. 계속 기록하려면 창을 최소화해 두세요. 기록은 `%LOCALAPPDATA%\ClaudeObservability`에 있습니다.

### 제거

```powershell
bun "%USERPROFILE%\claude-observability\apps\desktop\main.ts" --uninstall
```

훅과 바로가기를 지웁니다. 기록은 남으니 지우려면 `%LOCALAPPDATA%\ClaudeObservability` 폴더를 지우고, 설치 폴더도 지우면 됩니다.
