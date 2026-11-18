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
    $BaseUrl = if ($env:CLAUDE_SESSION_SHARE_BASE_URL) { $env:CLAUDE_SESSION_SHARE_BASE_URL.TrimEnd('/') } else { 'https://raw.githubusercontent.com/unmet23-lab/claude-session-share/main' }
    $InstallDir = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'claude-session-share'))
    $HomeFile = Join-Path $InstallDir 'runtime-home.txt'
    $originalHome = $env:CLAUDE_SESSION_SHARE_HOME
    $registered = if ([IO.File]::Exists($HomeFile)) { [IO.File]::ReadAllText($HomeFile).Trim() }
    $Data = if ($originalHome) { [IO.Path]::GetFullPath($originalHome) } elseif ($registered) { $registered } else { $InstallDir }
    $Native = Join-Path $InstallDir 'claude-session-share.exe'
    $Legacy = Join-Path $InstallDir 'claude-session-share.mjs'
    $PidPath = Join-Path $Data 'claude-session-share.pid'
    $State = Join-Path $Data 'claude-session-share.json'
    $Startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'claude-session-share.vbs'
    $ExpectedHash = '1D2D661B1ED1F14F411B5DB3665AE98A1145DDDC795132E4232DF1E9E9354880'

    function Fetch([string]$relative, [string]$to) {
        if ($Here -and (Test-Path -LiteralPath (Join-Path $Here $relative) -PathType Leaf)) {
            Copy-Item -LiteralPath (Join-Path $Here $relative) -Destination $to
        } else {
            Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$relative" -OutFile $to
        }
    }
    function File-Digest([string]$path) {
        $sha = [Security.Cryptography.SHA256]::Create()
        $stream = [IO.File]::OpenRead($path)
        try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
        finally { $stream.Dispose(); $sha.Dispose() }
    }
    function Install-Legacy {
        $legacyBootstrap = Join-Path ([IO.Path]::GetTempPath()) ('session-share-legacy-' + [guid]::NewGuid().ToString('N') + '.ps1')
        try {
            Fetch 'legacy/install.ps1' $legacyBootstrap
            if ((File-Digest $legacyBootstrap) -ne 'E3E5D6F5D7D6DE27F0E5FF09E7A71C35649C403B492ED7D91035C1087DDF8B0A') { throw '이전 설치 도우미를 확인하지 못했습니다.' }
            & $legacyBootstrap -Checkout $Here
        } finally { [IO.File]::Delete($legacyBootstrap) }
    }
    function Get-Watchers {
        $legacyArgs = '(?:^|\s)"?' + [regex]::Escape($Legacy) + '"?\s*$'
        Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='claude-session-share.exe'" |
            Where-Object {
                ($_.Name -eq 'node.exe' -and $_.CommandLine -match $legacyArgs) -or
                ($_.ExecutablePath -eq $Native -and $_.CommandLine -notmatch '\s--')
            }
    }
    function Stop-Installed($workers) {
        foreach ($p in $workers) {
            if ($p.ExecutablePath -eq $Native) {
                & $Native --stop
                if ($LASTEXITCODE -ne 0) { throw '현재 지켜보기가 종료 요청을 처리하지 못했습니다.' }
            } else {
                Stop-Process -Id $p.ProcessId -ErrorAction Stop
            }
            Wait-Process -Id $p.ProcessId -Timeout 30 -ErrorAction SilentlyContinue
            if (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue) { throw "지켜보기가 아직 실행 중입니다. PID $($p.ProcessId)" }
        }
    }
    function Start-Entry {
        Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $Startup + '"') -WindowStyle Hidden
    }
    function Save-Original([string]$target, [string]$staged) {
        $saved = $null
        $tempFile = Join-Path ([IO.Path]::GetDirectoryName($target)) ('.install-' + [guid]::NewGuid().ToString('N') + '.tmp')
        try {
            [IO.File]::Copy($staged, $tempFile)
            if ([IO.File]::Exists($target)) {
                $saved = Join-Path $stage ([guid]::NewGuid().ToString())
                [IO.File]::Copy($target, $saved)
                # Use the Win32 atomic replace operation. Windows PowerShell maps a null string to "".
                $unused = $tempFile + '.old'
                try { [IO.File]::Replace($tempFile, $target, $unused) }
                finally { [IO.File]::Delete($unused) }
            } else { [IO.File]::Move($tempFile, $target) }
            $changes.Add([pscustomobject]@{ Path=$target; Saved=$saved })
        } finally { [IO.File]::Delete($tempFile) }
    }
    $lock = $null
    $stage = $null
    $keepStage = $false
    $stopped = $false
    $started = $false
    $workers = @()
    $changes = New-Object 'System.Collections.Generic.List[object]'
    try {
        if ($registered -and $registered.TrimEnd('\') -ne $Data.TrimEnd('\')) {
            throw '설치된 지켜보기가 다른 데이터 폴더를 사용합니다. 이 창의 CLAUDE_SESSION_SHARE_HOME을 비우면 같은 폴더로 업데이트합니다.'
        }
        $env:CLAUDE_SESSION_SHARE_HOME = $Data
        if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) { throw 'Windows 전용입니다.' }
        $probeName = ".claude-session-share-probe-$PID"
        $probe = Join-Path $env:LOCALAPPDATA $probeName
        [IO.File]::WriteAllText($probe,'')
        try {
            $boxed = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -ErrorAction SilentlyContinue |
                Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "LocalCache\Local\$probeName") } | Select-Object -First 1
            if ($boxed) { throw '이 창은 AppData가 다른 위치로 연결된 앱 안의 터미널입니다. 시작 메뉴에서 PowerShell을 열어 설치하세요.' }
        } finally { [IO.File]::Delete($probe) }

        if (-not [Environment]::Is64BitOperatingSystem) { Install-Legacy; return }

        [IO.Directory]::CreateDirectory($InstallDir) | Out-Null
        [IO.Directory]::CreateDirectory($Data) | Out-Null
        $lock = [IO.File]::Open((Join-Path $InstallDir '.install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
        $stage = Join-Path $InstallDir ('.install-' + [guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($stage) | Out-Null
        $newExe = Join-Path $stage 'claude-session-share.exe'
        $remove = Join-Path $stage 'uninstall.ps1'
        $shim = Join-Path $stage 'compat.mjs'
        $notices = Join-Path $stage 'NOTICES.txt'
        Fetch 'dist/windows-x64/claude-session-share.exe' $newExe
        if ((File-Digest $newExe) -ne $ExpectedHash) { throw '받은 실행 파일의 SHA-256이 이 설치 판과 다릅니다. 설치 한 줄을 다시 실행하세요.' }
        $check = New-Object Diagnostics.ProcessStartInfo
        $check.FileName = $newExe
        $check.Arguments = '--help'
        $check.UseShellExecute = $false
        $check.CreateNoWindow = $true
        $check.RedirectStandardOutput = $true
        try { $test = [Diagnostics.Process]::Start($check) }
        catch {
            $cause = $_.Exception.GetBaseException()
            if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -in 193,216 -and
                ($env:PROCESSOR_ARCHITECTURE -like 'ARM*' -or $env:PROCESSOR_ARCHITEW6432 -like 'ARM*')) {
                Install-Legacy
                return
            }
            throw
        }
        try {
            $null = $test.StandardOutput.ReadToEnd()
            $test.WaitForExit()
            if ($test.ExitCode -ne 0) { throw '이 PC에서 실행 파일을 시작할 수 없습니다.' }
        } finally { $test.Dispose() }
        Fetch 'uninstall.ps1' $remove
        Fetch 'claude-session-share.mjs' $shim
        Fetch 'dist/windows-x64/NOTICES.txt' $notices

        $vbs = Join-Path $stage 'startup.vbs'
        $nativeEsc = $Native.Replace('"','""')
        $launcher = 'CreateObject("WScript.Shell").Run """' + $nativeEsc + '""", 0, False'
        [IO.File]::WriteAllText($vbs, $launcher, [Text.Encoding]::Unicode)
        $workers = @(Get-Watchers)
        if ($workers.Count -gt 1) { throw '설치 경로에서 지켜보기가 여러 개 실행 중입니다.' }
        if ($workers.Count -and (-not [IO.File]::Exists($PidPath) -or [IO.File]::ReadAllText($PidPath).Trim() -ne [string]$workers[0].ProcessId)) {
            throw '현재 지켜보기의 데이터 폴더와 설치 설정이 다릅니다. 사용하던 CLAUDE_SESSION_SHARE_HOME으로 다시 실행하세요.'
        }
        $updating = [IO.File]::Exists($State)
        $migrating = $updating -and ((-not [IO.File]::Exists($Native)) -or ($workers.Count -and $workers[0].Name -eq 'node.exe'))
        Stop-Installed $workers
        $stopped = $true
        if (-not $updating -or $migrating -or -not $workers.Count) {
            Write-Host '동기화 전에 세션 폴더를 백업합니다.'
            & $newExe --backup-only
            if ($LASTEXITCODE -ne 0) { throw '동기화 전 백업에 실패했습니다.' }
            if ($updating) {
                [IO.File]::Copy($State, (Join-Path $Data ('claude-session-share.before-native-' + [guid]::NewGuid().ToString('N') + '.json')))
            }
        }
        $stagedHome = Join-Path $stage 'runtime-home.txt'
        [IO.File]::WriteAllText($stagedHome, $Data)
        Save-Original $HomeFile $stagedHome
        Save-Original $Native $newExe
        Save-Original (Join-Path $InstallDir 'NOTICES.txt') $notices
        Save-Original (Join-Path $InstallDir 'uninstall.ps1') $remove
        Save-Original $Legacy $shim
        Save-Original $Startup $vbs
        Start-Entry
        $started = $true
        for ($i=0; $i -lt 120; $i++) {
            Start-Sleep -Milliseconds 250
            if ([IO.File]::Exists($PidPath)) {
                $watchId = 0
                if ([int]::TryParse([IO.File]::ReadAllText($PidPath).Trim(), [ref]$watchId)) {
                    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$watchId" -ErrorAction SilentlyContinue
                    if ($proc -and $proc.ExecutablePath -eq $Native) { break }
                }
            }
        }
        if (-not $proc -or $proc.ExecutablePath -ne $Native) { throw '30초 안에 설치된 지켜보기를 확인하지 못했습니다.' }
        # The daemon handles --once under its own lock and replies after saving state.
        & $Native --once
        if ($LASTEXITCODE -ne 0 -or -not (Get-Process -Id $watchId -ErrorAction SilentlyContinue)) { throw '지켜보기가 첫 동기화를 마치지 못했습니다.' }
        if ($updating) { Write-Host '업데이트했습니다. Rust 지켜보기가 실행 중입니다.' -ForegroundColor Green }
        else { Write-Host '설치했습니다. 작업 표시줄에서 Claude를 완전히 종료한 뒤 다시 실행하세요.' -ForegroundColor Green }
    } catch {
        $reason = $_
        $restoreErrors = New-Object 'System.Collections.Generic.List[string]'
        if ($started) {
            try { Stop-Installed @(Get-Watchers) } catch { $restoreErrors.Add($_.Exception.Message) }
        }
        for ($i=$changes.Count-1; $i -ge 0; $i--) {
            $entry = $changes[$i]
            try {
                if ($entry.Saved) { [IO.File]::Copy($entry.Saved,$entry.Path,$true) }
                else { [IO.File]::Delete($entry.Path) }
            } catch { $restoreErrors.Add("$($entry.Path): $($_.Exception.Message)") }
        }
        if (-not $restoreErrors.Count -and $stopped -and $workers.Count) {
            try {
                if ([IO.File]::Exists($Startup)) { Start-Entry }
                elseif ($workers[0].Name -eq 'node.exe') { Start-Process -FilePath $workers[0].ExecutablePath -ArgumentList ('"' + $Legacy + '"') -WindowStyle Hidden }
                else { Start-Process -FilePath $Native -WindowStyle Hidden }
            } catch { $restoreErrors.Add($_.Exception.Message) }
        }
        if ($restoreErrors.Count) {
            $keepStage = $true
            $changes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'rollback.json') -Encoding UTF8
            throw "설치와 복구를 마치지 못했습니다. 복구 파일: $stage. $($reason.Exception.Message) $($restoreErrors -join ' / ')"
        }
        throw "설치하지 못했습니다. $($reason.Exception.Message)"
    } finally {
        if (-not $keepStage -and $stage -and [IO.Directory]::Exists($stage) -and [IO.Path]::GetDirectoryName($stage) -eq $InstallDir -and [IO.Path]::GetFileName($stage) -match '^\.install-[a-f0-9]{32}$') {
            [IO.Directory]::Delete($stage,$true)
        }
        if ($lock) { $lock.Dispose() }
        $env:CLAUDE_SESSION_SHARE_HOME = $originalHome
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
