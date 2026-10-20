# claude-session-share

Claude 데스크톱(Windows)에서 5시간 한도가 차서 다른 계정으로 바꿔도, Code 탭의 세션 목록이 그대로 이어지게 하는 작은 도구입니다.

> 이 페이지는 **Windows PC**에서 여세요. 폰에서는 설치할 수 없습니다. *[English summary below](#english)*

| | |
|---|---|
| **이런 분께** | Windows에서 Claude 데스크톱 앱의 **Code 탭**(또는 Cowork)을 계정 두 개 이상으로 번갈아 쓰는 분. 다른 계정으로 로그인해도 하던 세션이 목록에 그대로 있고, 눌러서 이어 갈 수 있습니다. |
| **해당 없음** | 일반 채팅 대화(계정 서버에 있어 옮길 수 없습니다), Mac·Linux, 터미널에서만 `claude`를 쓰는 경우 |
| **건드리지 않는 것** | 대화 내용(`C:\Users\<이름>\.claude\projects`)은 열어 보지도, 바꾸지도, 지우지도 않습니다. 이 PC 안에서 계정 폴더끼리 복사만 하고 인터넷으로 아무것도 보내지 않습니다. 비밀번호·로그인 토큰은 읽지 않습니다. |
| **백업** | 처음 설치할 때 계정 폴더 전부를 통째로 백업하고, 그 뒤로도 매시간 백업해 최근 24개를 남깁니다. 끄거나 지워도 세션은 그대로 남습니다. |

## 빠른 시작 (5분)

설치 전에 Claude에서 Code 탭을 한 번 열어 두세요.

### 1. PowerShell을 열고 Node.js 확인 (없으면 설치, 2~3분)

시작 단추를 누르고 `powershell`이라고 친 뒤 Enter를 누르면 파란(또는 검은) 창이 열립니다. 보통 창이면 되고 「관리자 권한으로 실행」은 필요 없습니다. **Claude 앱 안의 터미널이나 Claude에게 시키는 방법은 안 됩니다**(설치기가 멈춥니다).

그 창에 아래를 치고 Enter를 누릅니다.

```powershell
node --version
```

`v20` 이상(예: `v22.12.0`)이 나오면 2번으로 갑니다. 빨간 글씨로 「'node' 용어가 … 인식되지 않습니다」가 나오면 없는 것입니다.

없으면 [nodejs.org](https://nodejs.org)에서 초록색 **LTS** 단추로 받은 파일을 실행하고, 묻는 것은 모두 「Next」→「Install」→「Finish」를 누릅니다. 「이 앱이 디바이스를 변경하도록 허용하시겠어요?」가 뜨면 「예」. 명령이 편하면 `winget install OpenJS.NodeJS.LTS`도 됩니다.

**설치가 끝나면 열어 둔 PowerShell 창을 닫고 새로 엽니다.** 먼저 연 창은 방금 설치한 Node.js를 찾지 못합니다.

### 2. 한 줄 붙여 넣기 (30초)

파일을 내려받을 필요는 없습니다. 아래 한 줄을 복사해(상자 오른쪽 위 복사 단추) PowerShell 창에 붙여 넣고(마우스 오른쪽 클릭 또는 Ctrl+V) Enter를 누릅니다.

```powershell
irm https://raw.githubusercontent.com/unmet23-lab/claude-session-share/main/install.ps1 | iex
```

10~30초 뒤 마지막에 **초록색으로 「설치했습니다.」**가 나오면 성공입니다. 그 위에 길게 나오는 표는 계정 폴더 상태이고 에러가 아닙니다.

- **노란 글**이 나오면 설치가 거기서 멈춘 것입니다. 그 글이 시키는 대로 한 뒤 같은 한 줄을 다시 붙여 넣으세요.
- **빨간 「설치하지 못했습니다:」**가 나오면 그 줄을 복사해 [이슈](https://github.com/unmet23-lab/claude-session-share/issues)로 남겨 주세요.

### 3. Claude를 완전히 껐다 켜기 (1분)

창의 **X를 누르면 꺼진 게 아니라 숨겨진 것**입니다. 작업 표시줄 오른쪽 아래 `^`(숨겨진 아이콘 표시)를 눌러 Claude 아이콘을 마우스 오른쪽 클릭하고 「종료(Quit)」를 누른 뒤, Claude를 다시 실행합니다. 잘 모르겠으면 PC를 다시 시작해도 같습니다.

이제 **이 PC에서 로그인한 적 있는** 모든 계정의 세션이 Code 탭에 보입니다. 한도가 차면 다른 계정으로 로그인하세요. 하던 세션이 목록에 그대로 있고, 눌러서 이어 갈 수 있습니다.

> **이 PC에서 처음 쓰는 계정은 한 번 더 껐다 켜야 보입니다.** 그 계정으로 처음 로그인하면 앱이 빈 목록부터 읽기 때문입니다. 도구가 1~2초 안에 세션을 채우고, 화면 오른쪽 아래에 「**Windows PowerShell**」 이름으로 「Claude 세션 공유 · 한 번만 껐다 켜 주세요」 알림을 띄웁니다. 그때 위와 같이 한 번만 완전히 껐다 켜면 됩니다(알림을 못 봤어도 같습니다). 그 계정은 다음부터 바꾸자마자 바로 보입니다.

**한도가 찼을 때 껐다 켜지 않으려면:** 설치한 날, 번갈아 쓸 계정마다 한 번씩 로그인했다가 원래 계정으로 돌아오세요. 그 계정에서 바로 일할 게 아니면 알림이 떠도 껐다 켤 필요는 없습니다. 이렇게 해 두면 나중에 한도가 차서 바꿀 때는 목록이 바로 보입니다.

## 잘 됐는지 확인

PowerShell에서 아래를 실행합니다. 설치 한 줄을 다시 붙여 넣어도 같은 표가 나오고 「업데이트했습니다.」로 끝납니다.

```powershell
node "$env:LOCALAPPDATA\claude-session-share\claude-session-share.mjs" --status
```

이렇게 나옵니다(긴 글자는 계정·조직 ID이고, 이메일은 나오지 않습니다).

```
지켜보기: 실행 중 (pid 34732)                          ← 자동 맞춤이 돌고 있음
Code 탭 세션(claude-code-sessions): 3곳, 맞춘 파일 120개
★ 1f3a9c20-…/7b2e4d11-…  41개 세션 기록, 파일 120개      ← ★ = 지금 로그인한 계정
  5c8e0a97-…/7b2e4d11-…  41개 세션 기록, 파일 120개
  9d41b6e3-…/0c7f2a58-…  41개 세션 기록, 파일 120개
  ○ 3곳이 모두 같습니다(세션 41개)                      ← 이 줄이 나오면 잘 된 것
Cowork 세션(local-agent-mode-sessions): 0곳, 맞춘 파일 0개
  (없음 — 쓰지 않으면 정상입니다)
맞추는 방식: 새 세션·지운 세션·로그인·로그아웃은 바로, 이미 있는 기록을 고쳐 쓴 것은 5분씩 모아서
백업: 2개, 최근 20261018-13
```

- 「○ …곳이 모두 같습니다」가 나오면 잘 맞춰진 것입니다.
- 「△ 아직 서로 다른 폴더가 있습니다」는 맞추는 중이라는 뜻입니다. 몇 초 뒤 다시 보세요.
- 「지켜보기: 꺼져 있음」이면 설치 한 줄을 다시 붙여 넣으세요.
- 「쉬는 짝 폴더 N곳」은 이 PC에서 한 번도 로그인한 적 없는 계정 폴더(또는 앱이 계정을 바꾸며 몇 초만 거친 짝)를 맞추는 대상에서 뺐다는 뜻입니다(아래 「자세히」). 에러가 아닙니다.

## 자주 막히는 곳

| 이런 글이 나오면 | 이렇게 하세요 |
|---|---|
| 노란 「Node.js가 없습니다」 | 1번대로 Node.js를 설치하고, **PowerShell 창을 새로 연 뒤** 한 줄을 다시 붙여 넣습니다. |
| 노란 「이 창은 … 같은 앱 안에서 연 터미널이라…」 | Claude 앱 안의 터미널이거나 Claude에게 시킨 경우입니다. 시작 단추 → `powershell` 입력 → Enter로 창을 따로 열어 다시 붙여 넣습니다. |
| 노란 「아직 Code 탭을 쓴 적이 없는 것 같습니다」 | 그대로 두면 됩니다. Code 탭을 쓰기 시작하면 자동으로 맞춥니다. |
| 다른 계정으로 바꿨더니 목록이 비어 있음 | 그 계정을 이 PC에서 처음 쓰는 경우가 대부분입니다. 알림이 떴든 안 떴든 3번대로 한 번만 완전히 껐다 켜면 보이고, 다음부터는 바꾸자마자 보입니다. 그래도 비어 있으면 위 「잘 됐는지 확인」에서 지켜보기가 실행 중인지 봅니다. |
| 껐다 켰는데 목록이 그대로 비어 있음 | 창의 X로 닫은 경우가 대부분입니다. 3번대로 `^` 안의 Claude 아이콘에서 「종료」를 누릅니다. 그래도 안 보이면 위 「잘 됐는지 확인」을 봅니다. |
| 처음 쓰는 계정으로 바꿨는데 알림이 안 뜸 | 2026년 10월 19일 이전 판은 알림이 뜨지 않았습니다. 설치 한 줄을 다시 붙여 넣으면 고친 판으로 바뀝니다. 그래도 안 뜨면 Windows 설정 > 시스템 > 알림에서 「Windows PowerShell」이 켜져 있는지 봅니다(방해 금지 중에는 알림 센터에만 쌓입니다). 알림이 없어도 껐다 켜면 목록은 보입니다. |
| 갑자기 계정을 바꿔도 목록이 맞춰지지 않음, 상태 보기에 「앱 데이터: (못 찾음…)」·「0곳」 | 앱(스토어판)이 데이터를 `%LOCALAPPDATA%\Claude-Data\…`로 옮긴 경우입니다(2026년 10월 19일부터 보임). 그 전 판은 이 자리를 몰라 그때부터 맞추지 못합니다. 2번의 한 줄을 다시 붙여 넣어 새 판으로 바꾸고 3번대로 한 번 껐다 켭니다. |
| `install.ps1`을 내려받아 더블클릭했더니 메모장이 열림 | 파일은 필요 없습니다. 2번의 한 줄만 붙여 넣습니다. |
| 빨간 「설치하지 못했습니다:」 | 그 줄을 복사해 [이슈](https://github.com/unmet23-lab/claude-session-share/issues)로 남겨 주세요. |

## 끄기·지우기(제거)

PowerShell에 아래 한 줄을 붙여 넣습니다.

```powershell
irm https://raw.githubusercontent.com/unmet23-lab/claude-session-share/main/uninstall.ps1 | iex
```

자동 맞춤을 멈추고 PC를 켤 때 자동으로 실행되지 않게 뺍니다. 「설치 폴더도 지울까요?」라고 물으면 **남기려면 그냥 Enter, 지우려면 `y`를 치고 Enter**를 누릅니다(설치 폴더에는 백업이 들어 있습니다). 인터넷 없이 끄려면 설치 폴더의 제거기를 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\claude-session-share\uninstall.ps1"
```

꺼도 지금까지 맞춘 세션은 각 계정 폴더에 그대로 있습니다. 앞으로 만드는 세션은 다시 계정마다 따로 쌓입니다. Node.js도 그대로 남으니, 필요 없으면 Windows 설정 > 앱에서 지우세요.

## 주의

- **비공식 도구입니다.** Anthropic과 관계없습니다. 앱이 저장 방식을 바꾸면 동작하지 않을 수 있습니다.
- **확인한 환경은 하나입니다.** Windows 11의 Claude 데스크톱 2.42304.0(Microsoft Store판)에서 확인했습니다. 홈페이지에서 받은 Claude(`%APPDATA%\Claude`)도 찾도록 했지만 직접 확인하지는 못했습니다. 내 Claude가 어느 쪽인지 몰라도 됩니다. 설치기가 둘 다 찾아 「Claude 데이터: …」로 보여 줍니다.
- **보관 목록은 합쳐지지 않습니다.** 보관 목록(`archived-sessions.idx`)은 가장 최근에 바뀐 것으로 모든 계정이 맞춰집니다. 예약 작업은 작업마다 합칩니다(아래 「자세히」).
- **Mac과 Linux는 지원하지 않습니다.**

<details>
<summary><b>어떻게 동작하나요 (자세히)</b></summary>

### 어떤 문제인가요

사용량 한도 때문에 Claude 계정 여러 개를 번갈아 쓰면, 계정을 바꿀 때마다 Code 탭의 세션 목록이 비어 보입니다. 대화 원문(`~/.claude/projects`)은 그대로 남아 있습니다. 앱이 세션 목록을 계정마다 따로 저장하기 때문에 목록만 사라져 보이는 것입니다.

### 어떻게 푸나요

앱은 세션 목록을 계정·조직마다 다른 폴더(이 문서의 「계정 폴더」)에 둡니다.

```
<앱 데이터>\claude-code-sessions\<계정 ID>\<조직 ID>\
    local_*.json            세션 기록
    deleted_*               앱이 지운 세션의 표식
    archived-sessions.idx   보관한 세션 목록
    scheduled-tasks.json    예약 작업
```

이 도구의 자동 맞춤 프로그램(지켜보기)이 이 계정 폴더들을 서로 똑같이 맞춥니다.

- 한 폴더에서 생기거나 지워진 파일은 1~2초 안에 나머지 폴더 전부에 옮깁니다. 새 세션이 생기거나 세션을 지우면 다른 계정 폴더에도 곧바로 반영됩니다.
- 이미 있는 세션 기록을 고쳐 쓴 것은 5분씩 모아, 파일마다 마지막 판만 옮깁니다. 앱은 세션 기록(한 개 약 100KB)을 대화가 오갈 때마다 다시 쓰는데, 그때마다 모든 계정 폴더에 옮기면 한 시간에 수 GB를 쓰게 됩니다.
- 앱 기록(`main.log`)에 로그아웃·로그인 줄이 보이면 기다리지 않고 바로 전부 맞춥니다. 로그아웃한 뒤 다음 로그인까지는 모으지 않습니다. 앱은 로그인할 때만 목록을 읽으므로, 계정을 바꿀 때는 모든 폴더가 이미 최신입니다.
- 맞추는 대상은 이 PC에서 로그인한 적 있는 계정 폴더입니다(앱 기록과 터미널 `claude` 로그인 파일로 압니다). 한 번도 로그인한 적 없는 계정 폴더(옛 판이 계정×조직 조합으로 만들어 둔 것 등)는 다른 폴더와 맞춰진 상태로 설치 폴더의 백업(`날짜-시각-parked\`)으로 옮겨 쉬게 합니다. 그 계정으로 처음 로그인하면 앱이 빈 폴더를 새로 만들고, 도구가 바로 채운 뒤 「한 번만 껐다 켜 주세요」 알림을 띄웁니다(처음 쓰는 계정과 같습니다). 앱 기록을 못 읽었거나 만든 지 한 시간이 안 된 폴더는 건드리지 않습니다.
- 앱은 계정을 바꿀 때 「앞 계정 + 새 계정의 조직」 짝으로 몇 초만 초기화했다가 곧바로 새 계정으로 다시 초기화하기도 합니다(앱 기록에 로그인 줄이 1~13초 사이로 둘 이어짐). 이 짝은 앱이 실제로 쓰지 않으므로 로그인 기록으로 치지 않고, 그 폴더는 채우지 않고 두었다가 쉬게 합니다. 그래서 처음 보는 계정의 로그인은 30초 동안 지켜본 뒤 채우고 알립니다.
- 같은 파일이 폴더마다 다르면 더 최근에 고친 쪽이 이깁니다.
- 앱이 지운 세션은 다른 폴더에 옛 사본이 있어도 되살리지 않습니다.
- 앱이 잠깐 쓰고 지우는 임시 파일(`*.tmp`)은 옮기지 않습니다.
- 예약 작업 목록(`scheduled-tasks.json`)은 파일째 맞추지 않고 작업마다 합칩니다. 아래 「예약 작업」을 보세요.
- Cowork 세션 폴더(`local-agent-mode-sessions`)도 같은 방식으로 맞춥니다.
- 앱은 폴더를 지켜보지 않고 로그인할 때만 목록을 읽습니다. 그래서 앱 기록(`main.log`)에 「Loaded 0 persisted sessions」가 남고 그 직전 로그인 줄의 `existingSessions`도 0이면(처음 쓰는 계정), 그 폴더를 채운 뒤 「한 번만 껐다 켜 주세요」 알림을 띄웁니다. 같은 계정으로 다시 로그인한 경우(`existingSessions`가 0보다 큼)는 목록이 이미 보이므로 알리지 않습니다. 설치 직후 첫 맞추기 때 읽는 지난 기록에도 알리지 않습니다(설치기가 따로 「껐다 켜세요」를 알려 줍니다).

### 예약 작업

앱은 계정에 로그인할 때마다 그 계정의 예약 작업 목록을 다시 씁니다. 처음 로그인하는 계정에는 빈 목록을 새로 씁니다. 파일째 「최근 것이 이김」으로 맞추면 이 빈 목록이 다른 계정의 예약까지 모두 지웁니다. 그래서 예약 목록만은 작업마다 합칩니다.

- 어느 계정에서 만든 작업이든 모든 계정 목록에 더합니다. 같은 작업이 다르면 더 최근에 바뀐 쪽으로 맞춥니다.
- 작업이 빠지면 앱이 그 계정에서 실제로 알던 작업이 하나 빠졌을 때만 지운 것으로 봅니다. 「실제로 알던 작업」은 로그인할 때 읽었거나 그 계정에서 직접 만든 작업입니다.
- 처음 로그인한 계정의 빈 목록, 앱이 아직 모르는 작업(다른 계정에서 넘어온 것), 한 번에 둘 이상 빠진 경우는 지우지 않고 되살립니다.
- 지금 쓰는 계정의 목록에 작업을 되살린 경우, 앱은 그 작업을 Claude를 껐다 켠 뒤에 다시 돌립니다. 이때는 윈도 알림으로 알려 줍니다.

### 바로 가기 폴더로 묶지 않는 이유

계정 폴더들을 바로 가기 폴더(junction·symlink)로 묶으면 더 간단할 것 같지만, 앱이 바로 가기 폴더에는 세션 저장을 거부합니다. 앱 기록(`main.log`)에 `Refusing non-directory at private dir path (symlink/file plant)`가 남습니다. 그래서 실제 폴더끼리 복사해 맞춥니다.

### 설치기가 하는 일

1. Claude·Codex 같은 앱 안의 터미널에서 실행했는지 봅니다. 그렇다면 멈춥니다(그런 창에서는 PC를 켤 때 자동 실행되지 않습니다).
2. Node.js 20 이상이 있는지 확인합니다.
3. Claude의 세션 폴더를 찾습니다. 아직 없으면(Code 탭을 쓴 적이 없으면) 그대로 설치하고, 나중에 생기면 맞춥니다.
4. 스크립트와 제거기를 `%LOCALAPPDATA%\claude-session-share\`에 둡니다.
5. PC를 켜고 윈도에 로그인할 때 창 없이 자동으로 시작되도록 시작프로그램 폴더(`shell:startup`)에 `claude-session-share.vbs`를 만듭니다.
6. 처음 설치라면 모든 계정 폴더를 통째로 백업한 뒤 한 번 맞춥니다.
7. 자동 맞춤을 시작하고 상태를 보여 줍니다.

설치 한 줄을 다시 실행하면 업데이트입니다. 전체 백업과 첫 맞추기만 건너뛰고 나머지를 다시 합니다.

### 파일 위치

| 무엇 | 위치 |
|---|---|
| 스크립트·상태·기록·백업 | `%LOCALAPPDATA%\claude-session-share\` (탐색기 주소창에 붙여 넣으면 열립니다) |
| 자동 실행 | 시작프로그램 폴더(`shell:startup`)의 `claude-session-share.vbs` |
| 앱 세션 목록, Microsoft Store판 | `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code-sessions\` |
| 앱 세션 목록, Microsoft Store판(앱이 데이터를 패키지 밖으로 옮긴 뒤) | `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\claude-code-sessions\` — 옛 자리엔 `.user-data-left.*` 표식만 남습니다. 앱이 계정마다 켜고 끄는 설정이라 다시 패키지 안으로 돌아갈 수도 있고, 이 도구는 세션 폴더가 있는 쪽을 따라갑니다 |
| 앱 세션 목록, 홈페이지판 | `%APPDATA%\Claude\claude-code-sessions\` |
| 앱 기록 | `%LOCALAPPDATA%\Claude\logs\main.log` |

설치 폴더 안에는 다음 파일이 생깁니다.

| 파일 | 내용 |
|---|---|
| `claude-session-share.mjs` | 자동 맞춤(지켜보기) 스크립트 |
| `uninstall.ps1` | 제거기 사본 |
| `claude-session-share.json` | 지난번 맞춘 모습. 지켜보기를 다시 켜도 삭제를 알아보는 데 씁니다. 바뀐 것이 있을 때만 씁니다(로그인·로그아웃은 2초 안에, 맞춘 파일 목록만 바뀐 것은 1분에 한 번까지). |
| `claude-session-share.log` | 무엇을 옮기고 지웠는지 남긴 기록 |
| `claude-session-backups\` | `날짜-시각-before-mirror\`는 설치 때 전체 백업, `날짜-시\`는 매시간 백업, `날짜-시각-parked\`는 로그인 기록이 없어 쉬게 한 계정 폴더 |

### 백업에서 되돌리기(고급)

지켜보기는 더 최근에 고친 파일을 퍼뜨립니다. 그래서 백업에서 꺼낸 파일은 수정 시각을 지금으로 바꿔야 모든 계정 폴더로 퍼집니다.

```powershell
$f = "<계정 폴더>\scheduled-tasks.json"
Copy-Item "<백업 폴더>\scheduled-tasks.json" $f
(Get-Item $f).LastWriteTime = Get-Date
```

앱이 지운 세션은 삭제 표식이 남아 있어서 이 방법으로 되살아나지 않습니다.

### 설정(고급)

보통은 설정할 것이 없습니다. 필요하면 사용자 환경 변수로 바꿉니다.

| 환경 변수 | 뜻 |
|---|---|
| `CLAUDE_SESSION_SHARE_HOME` | 상태·기록·백업을 둘 폴더. 기본은 `%LOCALAPPDATA%\claude-session-share` |
| `CLAUDE_SESSION_SHARE_CONFIG_DIRS` | 터미널 `claude`의 다른 로그인 폴더들(`;`로 구분). 그 폴더의 `.claude.json`에 있는 계정도 미리 채워 둡니다. |
| `CLAUDE_SESSION_SHARE_BATCH_MS` | 고쳐 쓴 세션 기록을 모으는 시간(밀리초). 기본 300000(5분). 새 파일·지운 파일·로그인·로그아웃은 이 값과 상관없이 바로 맞춥니다. |

`~/.claude.json`과 `CLAUDE_CONFIG_DIR`은 따로 설정하지 않아도 읽습니다(계정·조직 ID만 봅니다).

### 시험

```powershell
node --test
```

가짜 앱 데이터 폴더를 만들어 돌리므로 실제 앱 데이터는 건드리지 않습니다. 윈도 알림도 띄우지 않고 환경 변수 `CLAUDE_SESSION_SHARE_NOTIFY_FILE`로 정한 파일에 적습니다. Claude 앱 안의 터미널이 아니라 보통 PowerShell에서 실행합니다.

</details>

## 라이선스

[MIT](LICENSE)

---

<a id="english"></a>

## English

**What it does.** If you rotate several Claude accounts in the Claude desktop app on Windows, the Code tab shows an empty session list whenever you switch. Your transcripts in `~/.claude/projects` are still there. The app simply keeps its session list in a separate folder for each account and organization pair, under `claude-code-sessions\<account id>\<org id>\`. This tool keeps all of those folders identical. New and deleted files are copied across within a second or two; rewrites of existing session records (the app rewrites a ~100 KB record on every turn) are batched for 60 seconds and only the latest version is copied. As soon as the app's log shows a sign-out or sign-in, everything is synced at once, and nothing is batched between a sign-out and the next sign-in, so every folder is current whenever the app reads one. Only folders of account pairs that have signed in on this PC are kept in sync; folders that never did (for example account × organization combinations created by older versions) are moved into the backup folder (`*-parked`) once they match the others, and a first sign-in there takes the usual first-use path (the folder is filled and you are asked to restart Claude once). When switching accounts the app sometimes initializes the previous account with the new organization for a few seconds before the real sign-in; such pass-through pairs do not count as sign-ins, their folders are left empty and later parked, so the first sign-in of a new pair is watched for 30 seconds before it is filled. It lets the newest version of a file win, skips the app's short-lived `*.tmp` files, and never revives a session the app deleted. Cowork sessions (`local-agent-mode-sessions`) are mirrored the same way. It never reads, changes or deletes your conversations, sends nothing over the internet, and does not read passwords or login tokens. Regular chat conversations live on Anthropic's servers per account and are not affected.

**Why not a junction?** The app refuses to save sessions into a folder that is a junction or symlink. Its log says `Refusing non-directory at private dir path (symlink/file plant)`. So the tool mirrors real folders instead.

**Install.** You need Node.js 20 or newer (check with `node --version`; install the LTS from nodejs.org or `winget install OpenJS.NodeJS.LTS`, then open a new PowerShell window). Open a normal PowerShell window from the Start menu — not a terminal inside the Claude app, which the installer refuses — and run:

```powershell
irm https://raw.githubusercontent.com/unmet23-lab/claude-session-share/main/install.ps1 | iex
```

It ends with a green 「설치했습니다.」 ("Installed."). Then fully quit Claude from the tray icon (closing the window only hides it) and start it again. The installer puts the script in `%LOCALAPPDATA%\claude-session-share\` and adds `claude-session-share.vbs` to your Startup folder. It backs up every account folder, mirrors them once, then starts the watcher. Run the same line again to update.

**Status and removal.**

```powershell
node "$env:LOCALAPPDATA\claude-session-share\claude-session-share.mjs" --status
irm https://raw.githubusercontent.com/unmet23-lab/claude-session-share/main/uninstall.ps1 | iex
```

The status ends with a line like 「○ 3곳이 모두 같습니다」 ("all 3 folders match") when everything is in sync. The uninstaller stops the watcher and removes the Startup entry. It asks before deleting the install folder, which holds the backups, and keeps it by default.

**Notes.**

- This is an unofficial tool and is not affiliated with Anthropic.
- It was tested only with Claude desktop 2.42304.0–2.42304.2 from the Microsoft Store on Windows 11.
- The first install backs up every account folder. While running, it backs up the fullest folder every hour and keeps the last 24.
- The archive index is not merged; the newest copy wins everywhere.
- The scheduled task list (`scheduled-tasks.json`) is merged task by task instead. The app rewrites this list on every sign-in and writes an empty one for a new account, which would otherwise wipe every account's tasks. A task counts as deleted only when one task the app actually knew in that account (read at sign-in or created there) disappears. An empty list from a new account, tasks the app has not loaded yet, and several tasks vanishing at once are restored instead. If tasks are restored into the account you are using, restart Claude so it runs them again.
- The first time you sign in with an account on this PC, the app reads an empty list. The tool fills the folder at once and shows a Windows notification (sent as "Windows PowerShell"). Restart Claude once and the sessions appear; that account shows them right away from then on. To avoid this restart when you hit a limit, sign in once with each account you plan to rotate right after installing, then switch back.
- Signing back in to the same account does not trigger the notification. Versions before 2026-10-19 never actually showed these notifications (the PowerShell process was started detached, without a console); run the install line again to update.
- Since 2026-10-19 the Store app may move its whole data folder out of the package to `%LOCALAPPDATA%\Claude-Data\claude_<id>` (only a `.user-data-left.*` marker stays behind), and because the app turns this on and off per account it can move back. The tool follows whichever place holds the session folders, never recreates a place the app has left, and never reads a vanished account folder as "everything deleted". Earlier versions lost track after such a move and stopped syncing (`--status` showed no app data); run the install line again to update.
- macOS and Linux are not supported.
- Messages from the installer and the script are in Korean.

## License

[MIT](LICENSE)
