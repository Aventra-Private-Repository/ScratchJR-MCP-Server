param([Parameter(Mandatory=$true)][string]$ServerFile,[Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

# True when the client's stored scratchjr entry already launches this checkout.
# An entry left behind by an older copy of this project points at whatever now
# lives at that path, so it has to be replaced rather than preserved.
function Test-PointsHere([string]$Text) {
    if (-not $Text) { return $false }
    # JSON and TOML escape each backslash in a path, plain output does not,
    # so compare with every backslash removed from both sides.
    $flat = $Text.ToLowerInvariant().Replace('\', '')
    $wanted = $ServerFile.ToLowerInvariant().Replace('\', '')
    return $flat.Contains($wanted)
}

if (Get-Command codex -ErrorAction SilentlyContinue) {
    $codexPath = Join-Path $env:USERPROFILE '.codex\config.toml'
    if (Test-Path -LiteralPath $codexPath) { Copy-Item -LiteralPath $codexPath -Destination "$codexPath.scratchjr-$stamp.bak" }
    $ErrorActionPreference = 'Continue'
    $configured = & codex mcp get scratchjr --json 2>$null
    $exists = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if ($exists -and -not (Test-PointsHere ($configured | Out-String))) {
        Write-Output 'Codex scratchjr entry pointed elsewhere; replacing it.'
        & codex mcp remove scratchjr
        $exists = $false
    }
    if (-not $exists) {
        & codex mcp add scratchjr -- $NodePath $ServerFile
        if ($LASTEXITCODE -ne 0) { throw 'Codex registration failed' }
    } else { Write-Output 'Codex scratchjr entry already points here; preserved.' }
    # Change only this server's timeout values. Keep every other setting intact.
    $content = [IO.File]::ReadAllText($codexPath)
    $pattern = '(?ms)^\[mcp_servers\.scratchjr\]\r?\n(?<body>.*?)(?=^\[|\z)'
    $content = [regex]::Replace($content, $pattern, {
        param($match)
        $body = $match.Groups['body'].Value
        $body = [regex]::Replace($body, '(?m)^(startup_timeout_sec|tool_timeout_sec)\s*=.*\r?\n?', '')
        return "[mcp_servers.scratchjr]`nstartup_timeout_sec = 30`ntool_timeout_sec = 120`n$body"
    })
    [IO.File]::WriteAllText($codexPath, $content, [Text.UTF8Encoding]::new($false))
} else { Write-Warning 'Codex CLI not found. Copy config/codex.toml into your Codex config.' }

if (Get-Command claude.cmd -ErrorAction SilentlyContinue) {
    $claudePath = Join-Path $env:USERPROFILE '.claude.json'
    if (Test-Path -LiteralPath $claudePath) { Copy-Item -LiteralPath $claudePath -Destination "$claudePath.scratchjr-$stamp.bak" }
    $ErrorActionPreference = 'Continue'
    $configured = & claude.cmd mcp get scratchjr 2>$null
    $exists = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if ($exists -and -not (Test-PointsHere ($configured | Out-String))) {
        Write-Output 'Claude Code scratchjr entry pointed elsewhere; replacing it.'
        & claude.cmd mcp remove --scope user scratchjr
        $exists = $false
    }
    if (-not $exists) {
        & claude.cmd mcp add --scope user scratchjr -- $NodePath $ServerFile
        if ($LASTEXITCODE -ne 0) { throw 'Claude Code registration failed' }
    } else { Write-Output 'Claude Code scratchjr entry already points here; preserved.' }
} else { Write-Warning 'Claude Code CLI not found; Claude Desktop is configured.' }
