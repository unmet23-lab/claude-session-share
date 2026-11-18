# Package the exact Windows x64 release executable used by the installer.
param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = (Resolve-Path -LiteralPath $Executable).Path
$bytes = [IO.File]::ReadAllBytes($source)
$offset = [BitConverter]::ToInt32($bytes, 60)
if ([BitConverter]::ToUInt32($bytes, $offset) -ne 0x4550 -or
    [BitConverter]::ToUInt16($bytes, $offset + 4) -ne 0x8664) { throw 'A Windows x64 executable is required.' }
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') } finally { $sha.Dispose() }
$installer = Join-Path $root 'install.ps1'
$script = [IO.File]::ReadAllText($installer)
$pattern = [regex]'(?m)(?<=    \$ExpectedHash = '')(?:[A-F0-9]{64}|__DIGEST__)(?='')'
if ($pattern.Matches($script).Count -ne 1) { throw 'Installer checksum field missing or ambiguous.' }
$dir = Join-Path $root 'dist/windows-x64'
[IO.Directory]::CreateDirectory($dir) | Out-Null
[IO.File]::WriteAllBytes((Join-Path $dir 'claude-session-share.exe'), $bytes)
[IO.File]::WriteAllText($installer, $pattern.Replace($script, $hash))
Write-Output $hash
