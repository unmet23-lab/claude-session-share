# Preserve the last published Node installer on Windows systems that cannot run the x64 binary.
# All three files must come from the same immutable release. Do not substitute a launcher shim.
param([string]$Checkout)
$ErrorActionPreference = 'Stop'
$commit = '1a418a83d4632703dad2dba602159c2b45ee19d5'
$base = "https://raw.githubusercontent.com/unmet23-lab/claude-session-share/$commit"
$files = [ordered]@{
    'install.ps1' = 'F0A6BB104ED9E10AAC274DE929EB22C5CFF736B1D4E8DF466B8F903C5C3FB029'
    'uninstall.ps1' = 'A00014590D93BC303193FD012684D85DB8C131E87F800CA0085B3DF24DAEA46A'
    'claude-session-share.mjs' = '1BA7005E74B7127575D66FCACCA0BDFF26241050BC17228E42A8990E4FC89EDD'
}
$names = @($files.Keys)
$stage = Join-Path ([IO.Path]::GetTempPath()) ('claude-session-legacy-' + [guid]::NewGuid().ToString('N'))
$archive = Join-Path $stage 'release.zip'
$priorBase = $env:CLAUDE_SESSION_SHARE_BASE_URL
[IO.Directory]::CreateDirectory($stage) | Out-Null
try {
    $local = $false
    if ($Checkout -and (Test-Path -LiteralPath (Join-Path $Checkout '.git')) -and (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) {
        try {
            & git -C $Checkout archive --format=zip "--output=$archive" $commit -- @names 2>$null
            $local = ($LASTEXITCODE -eq 0)
        } catch { $local = $false }
    }
    if ($local) {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($archive)
        try {
            foreach ($name in $names) {
                $entry = $zip.GetEntry($name)
                if (!$entry) { throw "Missing $name in the pinned Node release." }
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $stage $name))
            }
        } finally { $zip.Dispose() }
    } else {
        foreach ($name in $names) {
            Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile (Join-Path $stage $name)
        }
    }
    foreach ($name in $names) {
        $sha = (Get-FileHash -LiteralPath (Join-Path $stage $name) -Algorithm SHA256).Hash
        if ($sha -ne $files[$name]) { throw "SHA-256 mismatch for $name in the pinned Node release." }
    }
    $env:CLAUDE_SESSION_SHARE_BASE_URL = $base
    & (Join-Path $stage 'install.ps1')
} finally {
    $env:CLAUDE_SESSION_SHARE_BASE_URL = $priorBase
    foreach ($name in $names) { [IO.File]::Delete((Join-Path $stage $name)) }
    [IO.File]::Delete($archive)
    [IO.Directory]::Delete($stage)
}
