# claude-session-share uninstaller for Windows: stops the watcher and removes the startup entry.
#   irm https://raw.githubusercontent.com/unmet23-lab/claude-session-share/main/uninstall.ps1 | iex
# It asks before deleting the install folder (which holds the backups); the default is to keep it.
# Session records already copied into each account folder stay where they are.
#
# Notes for editors: same layout as install.ps1. Keep this file UTF-8 without a BOM, keep the code
# outside the $Body here-string ASCII-only, and keep the line before the closing '@ ASCII.

& {
$Body = @'
    $ErrorActionPreference = 'Stop'
    $InstallDir = Join-Path $env:LOCALAPPDATA 'claude-session-share'
    $InstallDir = [IO.Path]::GetFullPath($InstallDir)
    $Native = Join-Path $InstallDir 'claude-session-share.exe'
    $Legacy = Join-Path $InstallDir 'claude-session-share.mjs'
    $VbsPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'claude-session-share.vbs'
    $WatcherPattern = '(?:^|\s)"?' + [regex]::Escape($Legacy) + '"?\s*$'

    function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

    try {
        Say ''
        Say 'Claude 세션 공유 끄기' 'Cyan'
        # 0. Claude·Codex 같은 스토어 앱 안의 터미널이면 멈춘다(AppData 파일이 앱 전용 폴더로 돌려져 보인다)
        $probeName = ".claude-session-share-probe-$PID"
        $probe = Join-Path $env:LOCALAPPDATA $probeName
        [IO.File]::WriteAllText($probe, '')
        $boxed = @(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "LocalCache\Local\$probeName") } | Select-Object -First 1)
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        if ($boxed.Count) {
            Say "이 창은 $($boxed[0].Name.Split('_')[0]) 같은 앱 안에서 연 터미널이라 여기서는 끄기가 제대로 되지 않습니다." 'Yellow'
            Say '시작 단추 → powershell 입력 → Enter로 PowerShell을 따로 열어 같은 한 줄을 다시 붙여 넣으세요.' 'Yellow'
            return
        }

        # 1. 지켜보기 멈추기
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='claude-session-share.exe'" |
            Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -match $WatcherPattern) -or
                ($_.ExecutablePath -eq $Native -and $_.CommandLine -notmatch '\s--') })
        foreach ($p in $procs) {
            $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
            if (-not $proc) { continue }
            try {
                # Keep the handle for this instance. A terminated process can retain its PID
                # while its launcher still holds a handle, and the PID can later be reused.
                $null = $proc.Handle
                if ($proc.HasExited) { continue }
                if ([math]::Abs(($proc.StartTime - $p.CreationDate).TotalMilliseconds) -gt 2) { throw '지켜보기 프로세스가 바뀌었습니다.' }
                if ($p.ExecutablePath -eq $Native) {
                    $originalHome = $env:CLAUDE_SESSION_SHARE_HOME
                    try {
                        $homeFile = Join-Path $InstallDir 'runtime-home.txt'
                        if ([IO.File]::Exists($homeFile)) { $env:CLAUDE_SESSION_SHARE_HOME = [IO.File]::ReadAllText($homeFile).Trim() }
                        & $Native --stop
                    } finally { $env:CLAUDE_SESSION_SHARE_HOME = $originalHome }
                    if ($LASTEXITCODE -ne 0) { throw '지켜보기를 멈추지 못했습니다.' }
                } else { $proc.Kill() }
                if (-not $proc.WaitForExit(30000)) { throw "지켜보기가 아직 실행 중입니다. PID $($p.ProcessId)" }
            } finally { $proc.Dispose() }
            Say "  지켜보기를 멈췄습니다 (pid $($p.ProcessId))"
        }
        if ($procs.Count -eq 0) { Say '  돌고 있는 지켜보기가 없습니다.' }

        # 2. 시작프로그램에서 빼기
        if (Test-Path -LiteralPath $VbsPath) {
            Remove-Item -LiteralPath $VbsPath -Force
            Say "  시작프로그램에서 뺐습니다: $VbsPath"
        } else {
            Say '  시작프로그램 항목은 이미 없습니다.'
        }

        # 3. 설치 폴더는 물어보고 지운다(기본은 남김)
        if (Test-Path -LiteralPath $InstallDir) {
            $answer = ''
            Say "  설치 폴더: $InstallDir  (백업이 들어 있습니다)"
            try { $answer = Read-Host '  설치 폴더도 지울까요? 남기려면 그냥 Enter, 지우려면 y를 치고 Enter' } catch { }
            if ($InstallDir -ne [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'claude-session-share')) -or
                (Get-Item -LiteralPath $InstallDir).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                Say "  직접 지정하거나 연결한 폴더는 남겨 둡니다: $InstallDir"
            } elseif ($answer -match '^\s*(y|yes|예|네|ㅇ)\s*$') {
                if ((Get-Location).Path -like "$InstallDir*") { Set-Location $env:USERPROFILE }
                Remove-Item -LiteralPath $InstallDir -Recurse -Force
                Say '  설치 폴더를 지웠습니다.'
            } else {
                Say "  설치 폴더는 남겨 둡니다: $InstallDir"
            }
        }

        Say ''
        Say '껐습니다. 지금까지 맞춘 세션은 각 계정 폴더에 그대로 있고, 앞으로 만드는 세션은 다시 계정마다 따로 쌓입니다.' 'Green'
    } catch {
        Write-Host ''
        Write-Host "끄지 못했습니다: $($_.Exception.Message)" -ForegroundColor Red
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
    Write-Host "Could not read the uninstaller text. Use: irm https://raw.githubusercontent.com/unmet23-lab/claude-session-share/main/uninstall.ps1 | iex" -ForegroundColor Red
    return
}
& $Run
}
