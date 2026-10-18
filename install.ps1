# claude-session-share installer for Windows.
#   irm https://raw.githubusercontent.com/unmet23-lab/claude-session-share/main/install.ps1 | iex
# Running it again updates the script and restarts the watcher.
#
# Notes for editors: keep this file UTF-8 *without* a BOM (irm | iex cannot parse one) and keep
# everything outside the $Body here-string ASCII-only. Windows PowerShell 5.1 reads BOM-less files
# in the ANSI code page, which can swallow quotes and newlines next to Korean text. So the Korean
# body lives in a here-string and, when this runs as a file, is re-read as UTF-8 before it runs.
# Inside the body: no line may start with '@, and the last line before the closing '@ stays ASCII.

& {
$Here = $PSScriptRoot
$Body = @'
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $Repo = 'unmet23-lab/claude-session-share'
    $Branch = 'main'
    $BaseUrl = if ($env:CLAUDE_SESSION_SHARE_BASE_URL) { $env:CLAUDE_SESSION_SHARE_BASE_URL.TrimEnd('/') } else { "https://raw.githubusercontent.com/$Repo/$Branch" }
    $InstallDir = Join-Path $env:LOCALAPPDATA 'claude-session-share'
    $ScriptPath = Join-Path $InstallDir 'claude-session-share.mjs'
    $UninstallPath = Join-Path $InstallDir 'uninstall.ps1'
    $PidPath = Join-Path $InstallDir 'claude-session-share.pid'
    $StatePath = Join-Path $InstallDir 'claude-session-share.json'
    $VbsPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'claude-session-share.vbs'
    # 이 도구의 스크립트를 지켜보기로 돌리는 node만 고른다(--once·--status 같은 한 번 실행은 뺀다).
    $WatcherPattern = '[\\/"\s]claude-session-share\.mjs"?(\s|$)'

    function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

    function Stop-Watchers {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match $WatcherPattern -and $_.CommandLine -notmatch '\s--(once|status|help)\b' })
        foreach ($p in $procs) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            Say "  돌던 지켜보기를 멈췄습니다 (pid $($p.ProcessId))"
        }
        if ($procs.Count) { Wait-Process -Id $procs.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }
    }

    # node 출력을 UTF-8로 읽는다(콘솔 코드 페이지가 949여도 한글이 깨지지 않게).
    function Invoke-Node([string[]]$NodeArgs) {
        $oldPref = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $oldEnc = $null
        try { $oldEnc = [Console]::OutputEncoding; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
        try {
            $out = & $NodeExe $ScriptPath @NodeArgs 2>&1 | ForEach-Object { "$_" } | Out-String
            return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
        } finally {
            if ($oldEnc) { try { [Console]::OutputEncoding = $oldEnc } catch { } }
            $ErrorActionPreference = $oldPref
        }
    }

    # 저장소 파일을 임시 이름으로 받아 둔다. 파일로 실행했으면 옆의 파일을, 아니면 깃허브에서 받는다.
    function Get-RepoFile([string]$Name) {
        $tmp = Join-Path $InstallDir ".$Name.download"
        $local = if ($Here) { Join-Path $Here $Name } else { $null }
        if ($local -and (Test-Path -LiteralPath $local)) {
            Copy-Item -LiteralPath $local -Destination $tmp -Force
        } else {
            Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$Name" -OutFile $tmp
        }
        if ((Get-Item -LiteralPath $tmp).Length -lt 200) { Remove-Item -LiteralPath $tmp -Force; throw "$Name 파일을 제대로 받지 못했습니다." }
        return $tmp
    }

    try {
        Say ''
        Say 'Claude 세션 공유 설치' 'Cyan'

        if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) { Say 'Windows 전용입니다. Mac·Linux는 지원하지 않습니다.' 'Yellow'; return }

        # 1. Claude·Codex 같은 스토어 앱 안의 터미널이면 멈춘다(AppData 쓰기가 앱 전용 폴더로 돌려져 PC를 켤 때 실행되지 않는다).
        #    Node.js보다 먼저 본다 — Claude에게 「설치해 줘」라고 시킨 경우 두 번 막히지 않게.
        $packages = Join-Path $env:LOCALAPPDATA 'Packages'
        $probeName = ".claude-session-share-probe-$PID"
        $probe = Join-Path $env:LOCALAPPDATA $probeName
        [IO.File]::WriteAllText($probe, '')
        $boxed = @(Get-ChildItem -LiteralPath $packages -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "LocalCache\Local\$probeName") } | Select-Object -First 1)
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        if ($boxed.Count) {
            Say "이 창은 $($boxed[0].Name.Split('_')[0]) 같은 앱 안에서 연 터미널이라 여기서는 설치가 제대로 되지 않습니다(PC를 켤 때 자동 실행되지 않습니다)." 'Yellow'
            Say '시작 단추 → powershell 입력 → Enter로 PowerShell을 따로 열어 같은 한 줄을 다시 붙여 넣으세요.' 'Yellow'
            return
        }

        # 2. Node.js 20 이상
        $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $node) {
            Say 'Node.js가 없습니다. 먼저 Node.js(LTS)를 설치하세요.' 'Yellow'
            Say '  https://nodejs.org 에서 초록색 LTS 단추로 받아 설치  (또는 이 창에서: winget install OpenJS.NodeJS.LTS)' 'Yellow'
            Say '설치가 끝나면 이 창을 닫고 PowerShell을 새로 열어 같은 한 줄을 다시 붙여 넣으세요(이 창은 방금 설치한 Node.js를 못 찾습니다).' 'Yellow'
            return
        }
        $version = (& $node.Source --version | Out-String).Trim()
        $major = 0
        if ($version -match '^v(\d+)\.') { $major = [int]$Matches[1] }
        if ($major -lt 20) {
            Say "Node.js $version 은(는) 너무 오래됐습니다. 20 이상(LTS)이 필요합니다." 'Yellow'
            Say '  https://nodejs.org 에서 LTS를 받아 설치  (또는 이 창에서: winget install OpenJS.NodeJS.LTS)' 'Yellow'
            Say '설치가 끝나면 PowerShell을 새로 열어 같은 한 줄을 다시 붙여 넣으세요.' 'Yellow'
            return
        }
        $NodeExe = $node.Source
        # fnm처럼 창마다 바뀌는 임시 경로면 실제 node.exe 위치를 쓴다(로그인할 때도 찾을 수 있게).
        if ($NodeExe -match 'fnm_multishells') { $NodeExe = (& $NodeExe -p 'process.execPath' | Out-String).Trim() }
        Say "  Node.js $version  ($NodeExe)"

        # 3. Claude 데스크톱 세션 폴더(스토어판 또는 일반 설치판)
        $roots = @()
        if (Test-Path -LiteralPath $packages) {
            $roots += @(Get-ChildItem -LiteralPath $packages -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'LocalCache\Roaming\Claude' })
        }
        $roots += Join-Path $env:APPDATA 'Claude'
        $found = @($roots | Where-Object { (Test-Path -LiteralPath (Join-Path $_ 'claude-code-sessions')) -or (Test-Path -LiteralPath (Join-Path $_ 'local-agent-mode-sessions')) })
        if ($found.Count -eq 0) {
            Say '  아직 Code 탭을 쓴 적이 없는 것 같습니다(세션 폴더가 없음). 설치는 그대로 끝나고, Code 탭을 쓰기 시작하면 자동으로 맞춥니다.' 'Yellow'
        } else {
            foreach ($r in $found) { Say "  Claude 데이터: $r" }
        }

        # 4. 새 파일을 먼저 받아 둔다(받기에 실패하면 지금 설치는 그대로 둔다)
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        # 상태 파일은 첫 맞추기가 끝나야 생긴다. 그래서 첫 맞추기가 실패했다면 다시 실행할 때도 전체 백업부터 한다.
        $Updating = Test-Path -LiteralPath $StatePath
        $newScript = Get-RepoFile 'claude-session-share.mjs'
        $newUninstall = Get-RepoFile 'uninstall.ps1'
        Say ('  스크립트: ' + $(if ($Here) { "$Here 에서 복사" } else { "$BaseUrl 에서 받음" }))

        # 5. 돌고 있는 지켜보기를 멈추고 새 파일로 바꾼다
        Stop-Watchers
        Move-Item -LiteralPath $newScript -Destination $ScriptPath -Force
        Move-Item -LiteralPath $newUninstall -Destination $UninstallPath -Force
        Say "  설치 폴더: $InstallDir"

        # 6. 시작프로그램에 등록(PC를 켜고 윈도에 로그인할 때 node를 창 없이 띄운다). 경로에 한글이 있어도 되게 UTF-16으로 쓴다.
        $vbs = @"
' claude-session-share: starts the session-share watcher at logon (written by install.ps1)
CreateObject("WScript.Shell").Run """$NodeExe"" ""$ScriptPath""", 0, False
"@
        [IO.File]::WriteAllText($VbsPath, $vbs, [Text.Encoding]::Unicode)
        Say "  자동 실행(PC를 켤 때): $VbsPath"

        # 7. 처음 설치면 모든 계정 폴더를 통째로 백업한 뒤 한 번 맞춘다
        if (-not $Updating) {
            Say '  처음 맞추기 전에 모든 계정 폴더를 백업하고 한 번 맞춥니다...'
            $r = Invoke-Node @('--once', '--backup')
            if ($r.Code -ne 0) { Write-Host $r.Out; throw '처음 맞추기에 실패했습니다. 위 내용을 확인하세요(지켜보기는 켜지 않았습니다).' }
            $line = @($r.Out -split "`r?`n" | Where-Object { $_ -match '^맞추기 전 전체 백업' }) | Select-Object -First 1
            if ($line) { Say "  $line" }
        }

        # 8. 지켜보기 시작
        Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
        Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList "`"$VbsPath`""
        $started = 0
        for ($i = 0; $i -lt 60 -and -not $started; $i++) {
            Start-Sleep -Milliseconds 250
            if (Test-Path -LiteralPath $PidPath) {
                $id = 0
                if ([int]::TryParse((Get-Content -LiteralPath $PidPath -Raw).Trim(), [ref]$id) -and (Get-Process -Id $id -ErrorAction SilentlyContinue)) { $started = $id }
            }
        }
        if (-not $started) { throw "지켜보기가 15초 안에 시작되지 않았습니다. 직접 실행해 오류를 보세요:  node `"$ScriptPath`"" }
        Say "  지켜보기 시작 (pid $started)" 'Green'

        # 9. 상태
        Say ''
        $s = Invoke-Node @('--status')
        Write-Host $s.Out.TrimEnd()
        Say ''
        if ($Updating) {
            Say '업데이트했습니다. 자동 맞춤(지켜보기)이 새 스크립트로 다시 돌고 있습니다.' 'Green'
        } else {
            Say '설치했습니다. 위의 표는 계정 폴더 상태이고 에러가 아닙니다.' 'Green'
            Say '이제 Claude를 완전히 껐다 켜세요. 창의 X는 숨기기일 뿐이니, 작업 표시줄 오른쪽 아래 ^ 안의 Claude 아이콘을 마우스 오른쪽 클릭해 종료(Quit)한 뒤 다시 실행합니다.' 'Green'
            Say '그러면 이 PC에서 로그인한 적 있는 모든 계정의 세션이 Code 탭에 보입니다.' 'Green'
        }
        Say "  상태 보기:      node `"$ScriptPath`" --status"
        Say "  끄고 싶을 때:   irm $BaseUrl/uninstall.ps1 | iex"
    } catch {
        Write-Host ''
        Write-Host "설치하지 못했습니다: $($_.Exception.Message)" -ForegroundColor Red
    }
# end of body
'@
if ($PSCommandPath) {
    # Run as a file: re-read the body as UTF-8 so Korean text survives Windows PowerShell 5.1.
    $all = [IO.File]::ReadAllText($PSCommandPath, [Text.Encoding]::UTF8)
    $m = [regex]::Match($all, "(?s)\`$Body = @'\r?\n(.*?)\r?\n'@")
    if ($m.Success) { $Body = $m.Groups[1].Value }
}
try { $Run = [scriptblock]::Create($Body) } catch {
    Write-Host "Could not read the installer text. Use: irm https://raw.githubusercontent.com/unmet23-lab/claude-session-share/main/install.ps1 | iex" -ForegroundColor Red
    return
}
& $Run
}
