# claude-session-share

Claude 데스크톱(Windows)의 Code 탭에서 계정을 바꿔도 세션 목록이 그대로 보이게 하는 작은 도구입니다.

*[English summary below](#english)*

## 어떤 문제인가요

사용량 한도 때문에 Claude 계정 여러 개를 번갈아 쓰면, 계정을 바꿀 때마다 Code 탭의 세션 목록이 비어 보입니다. 대화 원문(`~/.claude/projects`)은 그대로 남아 있습니다. 앱이 세션 목록을 계정마다 따로 저장하기 때문에 목록만 사라져 보이는 것입니다.

## 어떻게 푸나요

앱은 세션 목록을 계정·조직 짝마다 다른 폴더에 둡니다.

```
<앱 데이터>\claude-code-sessions\<계정 ID>\<조직 ID>\
    local_*.json            세션 기록
    deleted_*               앱이 지운 세션의 표식
    archived-sessions.idx   보관한 세션 목록
    scheduled-tasks.json    예약 작업
```

이 도구는 이 짝 폴더들을 1~2초 안에 서로 똑같이 맞춥니다.

- 한 폴더에서 생기거나 바뀌거나 지워진 파일을 나머지 폴더 전부에 옮깁니다.
- 같은 파일이 폴더마다 다르면 더 최근에 바뀐 쪽이 이깁니다.
- 앱이 지운 세션은 다른 폴더에 옛 사본이 있어도 되살리지 않습니다.
- 예약 작업 목록(`scheduled-tasks.json`)은 파일째 맞추지 않고 작업마다 합칩니다. 아래 「예약 작업」을 보세요.
- Cowork 세션 폴더(`local-agent-mode-sessions`)도 같은 방식으로 맞춥니다.

### 예약 작업

앱은 계정에 로그인할 때마다 그 계정의 예약 작업 목록을 다시 씁니다. 처음 로그인하는 계정에는 빈 목록을 새로 씁니다. 파일째 「최근 것이 이김」으로 맞추면 이 빈 목록이 다른 계정의 예약까지 모두 지웁니다. 그래서 예약 목록만은 작업마다 합칩니다.

- 어느 계정에서 만든 작업이든 모든 계정 목록에 더합니다. 같은 작업이 다르면 더 최근에 바뀐 쪽으로 맞춥니다.
- 작업이 빠지면 앱이 그 계정에서 실제로 알던 작업이 하나 빠졌을 때만 지운 것으로 봅니다. 「실제로 알던 작업」은 로그인할 때 읽었거나 그 계정에서 직접 만든 작업입니다.
- 처음 로그인한 계정의 빈 목록, 앱이 아직 모르는 작업(다른 계정에서 넘어온 것), 한 번에 둘 이상 빠진 경우는 지우지 않고 되살립니다.
- 지금 쓰는 계정의 목록에 작업을 되살린 경우, 앱은 그 작업을 Claude를 껐다 켠 뒤에 다시 돌립니다. 이때는 윈도 알림으로 알려 줍니다.

짝 폴더를 연결 폴더(junction·symlink)로 묶으면 더 간단할 것 같지만, 앱이 연결 폴더에는 세션 저장을 거부합니다. 앱 기록(`main.log`)에 `Refusing non-directory at private dir path (symlink/file plant)`가 남습니다. 그래서 실제 폴더끼리 복사해 맞춥니다.

## 설치

[Node.js](https://nodejs.org) 20 이상이 필요합니다. 없으면 먼저 설치하고 새 PowerShell 창을 엽니다.

```powershell
winget install OpenJS.NodeJS.LTS
```

PowerShell에서 아래 한 줄을 실행합니다.

```powershell
irm https://raw.githubusercontent.com/unmet23-lab/claude-session-share/main/install.ps1 | iex
```

설치가 끝나면 Claude 데스크톱을 한 번 완전히 껐다 켭니다. 트레이 아이콘에서 종료한 뒤 다시 실행하면 됩니다. 그러면 모든 계정의 세션이 목록에 보입니다.

설치기가 하는 일은 다음과 같습니다.

1. Node.js 20 이상이 있는지 확인합니다.
2. 스크립트를 `%LOCALAPPDATA%\claude-session-share\`에 둡니다.
3. 로그인할 때 창 없이 돌도록 시작프로그램에 `claude-session-share.vbs`를 만듭니다.
4. 모든 계정 폴더를 통째로 백업한 뒤 한 번 맞춥니다.
5. 지켜보기를 시작하고 상태를 보여 줍니다.

설치 한 줄을 다시 실행하면 업데이트됩니다. 스크립트만 새로 받고 지켜보기를 다시 시작합니다.

## 상태 보기

```powershell
node "$env:LOCALAPPDATA\claude-session-share\claude-session-share.mjs" --status
```

계정 폴더마다 세션 기록 수가 나옵니다. 모든 줄의 수가 같으면 잘 맞춰진 것입니다.

## 끄기

```powershell
irm https://raw.githubusercontent.com/unmet23-lab/claude-session-share/main/uninstall.ps1 | iex
```

지켜보기를 멈추고 시작프로그램에서 뺍니다. 설치 폴더에는 백업이 있어서 지울지 물어보고, 기본은 남깁니다. 인터넷 없이 끄려면 설치 폴더의 제거기를 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\claude-session-share\uninstall.ps1"
```

꺼도 지금까지 맞춘 세션은 각 계정 폴더에 그대로 있습니다. 앞으로 만드는 세션은 다시 계정마다 따로 쌓입니다.

## 주의

- **비공식 도구입니다.** Anthropic과 관계없습니다. 앱이 저장 방식을 바꾸면 동작하지 않을 수 있습니다.
- **확인한 환경은 하나입니다.** Windows 11의 Claude 데스크톱 2.42304.0, Microsoft Store판에서 확인했습니다. 일반 설치판의 `%APPDATA%\Claude`도 찾도록 했지만 직접 확인하지는 못했습니다.
- **백업을 만듭니다.** 처음 설치할 때 모든 계정 폴더를 통째로 백업합니다. 그 뒤로는 세션 기록이 가장 많은 폴더를 매시간 백업하고 최근 24개를 남깁니다.
- **보관 목록은 합쳐지지 않습니다.** 보관 목록(`archived-sessions.idx`)은 계정마다 하나씩인데, 가장 최근에 바뀐 것으로 모두 맞춰집니다. 예약 작업 목록은 위처럼 작업마다 합칩니다.
- **처음 보는 계정은 한 번 재시작이 필요합니다.** 앱이 처음 로그인한 계정에서는 빈 목록을 먼저 읽습니다. 도구가 그 폴더를 바로 채우고 윈도 알림으로 알려 주니, 그때 한 번만 껐다 켜면 됩니다. 그 뒤로는 계정을 바꾸면 바로 보입니다.
- **Mac과 Linux는 지원하지 않습니다.**

## 파일 위치

| 무엇 | 위치 |
|---|---|
| 스크립트·상태·기록·백업 | `%LOCALAPPDATA%\claude-session-share\` |
| 자동 실행 | 시작프로그램 폴더(`shell:startup`)의 `claude-session-share.vbs` |
| 앱 세션 목록, 스토어판 | `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code-sessions\` |
| 앱 세션 목록, 일반 설치판 | `%APPDATA%\Claude\claude-code-sessions\` |
| 앱 기록 | `%LOCALAPPDATA%\Claude\logs\main.log` |

설치 폴더 안에는 다음 파일이 생깁니다.

| 파일 | 내용 |
|---|---|
| `claude-session-share.mjs` | 지켜보기 스크립트 |
| `uninstall.ps1` | 제거기 사본 |
| `claude-session-share.json` | 지난번 맞춘 모습. 지켜보기를 다시 켜도 삭제를 알아보는 데 씁니다. |
| `claude-session-share.log` | 무엇을 옮기고 지웠는지 남긴 기록 |
| `claude-session-backups\` | `날짜-시각-before-mirror\`는 설치 때 전체 백업, `날짜-시\`는 매시간 백업 |

## 백업에서 되돌리기

지켜보기는 더 최근에 바뀐 파일을 퍼뜨립니다. 그래서 백업에서 꺼낸 파일은 수정 시각을 지금으로 바꿔야 모든 계정 폴더로 퍼집니다.

```powershell
$f = "<계정 폴더>\scheduled-tasks.json"
Copy-Item "<백업 폴더>\scheduled-tasks.json" $f
(Get-Item $f).LastWriteTime = Get-Date
```

앱이 지운 세션은 삭제 표식이 남아 있어서 이 방법으로 되살아나지 않습니다.

## 설정

보통은 설정할 것이 없습니다. 필요하면 사용자 환경 변수로 바꿉니다.

| 환경 변수 | 뜻 |
|---|---|
| `CLAUDE_SESSION_SHARE_HOME` | 상태·기록·백업을 둘 폴더. 기본은 `%LOCALAPPDATA%\claude-session-share` |
| `CLAUDE_SESSION_SHARE_CONFIG_DIRS` | 터미널 `claude`의 다른 로그인 폴더들(`;`로 구분). 그 폴더의 `.claude.json`에 있는 계정도 미리 채워 둡니다. |

`~/.claude.json`과 `CLAUDE_CONFIG_DIR`은 따로 설정하지 않아도 읽습니다.

## 라이선스

[MIT](LICENSE)

---

<a id="english"></a>

## English

**What it does.** If you rotate several Claude accounts in the Claude desktop app on Windows, the Code tab shows an empty session list whenever you switch. Your transcripts in `~/.claude/projects` are still there. The app simply keeps its session list in a separate folder for each account and organization pair, under `claude-code-sessions\<account id>\<org id>\`. This tool keeps all of those folders identical within a second or two. It copies additions, changes and deletions across, lets the newest version of a file win, and never revives a session the app deleted. Cowork sessions (`local-agent-mode-sessions`) are mirrored the same way.

**Why not a junction?** The app refuses to save sessions into a folder that is a junction or symlink. Its log says `Refusing non-directory at private dir path (symlink/file plant)`. So the tool mirrors real folders instead.

**Install.** You need Node.js 20 or newer. Run this in PowerShell, then quit Claude from the tray icon and start it again.

```powershell
irm https://raw.githubusercontent.com/unmet23-lab/claude-session-share/main/install.ps1 | iex
```

The installer puts the script in `%LOCALAPPDATA%\claude-session-share\` and adds `claude-session-share.vbs` to your Startup folder. It backs up every account folder, mirrors them once, then starts the watcher. Run the same line again to update.

**Status and removal.**

```powershell
node "$env:LOCALAPPDATA\claude-session-share\claude-session-share.mjs" --status
irm https://raw.githubusercontent.com/unmet23-lab/claude-session-share/main/uninstall.ps1 | iex
```

The uninstaller stops the watcher and removes the Startup entry. It asks before deleting the install folder, which holds the backups, and keeps it by default.

**Notes.**

- This is an unofficial tool and is not affiliated with Anthropic.
- It was tested only with Claude desktop 2.42304.0 from the Microsoft Store on Windows 11.
- The first install backs up every account folder. While running, it backs up the fullest folder every hour and keeps the last 24.
- The archive index is not merged; the newest copy wins everywhere.
- The scheduled task list (`scheduled-tasks.json`) is merged task by task instead. The app rewrites this list on every sign-in and writes an empty one for a new account, which would otherwise wipe every account's tasks. A task counts as deleted only when one task the app actually knew in that account (read at sign-in or created there) disappears. An empty list from a new account, tasks the app has not loaded yet, and several tasks vanishing at once are restored instead. If tasks are restored into the account you are using, restart Claude so it runs them again.
- The first time you sign in with a new account, the app reads an empty list. The tool fills the folder at once and shows a Windows notification. Restart Claude once and the sessions appear.
- macOS and Linux are not supported.
- Messages from the installer and the script are in Korean.

## License

[MIT](LICENSE)
