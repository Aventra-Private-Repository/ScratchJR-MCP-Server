param([Parameter(Mandatory=$true)][string]$ServerFile,[Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
if (Get-Command codex -ErrorAction SilentlyContinue) {
    $codexPath = Join-Path $env:USERPROFILE '.codex\config.toml'
    if (Test-Path -LiteralPath $codexPath) { Copy-Item -LiteralPath $codexPath -Destination "$codexPath.scratchjr-$stamp.bak" }
    $ErrorActionPreference = 'Continue'
    $configured = & codex mcp get scratchjr --json 2>$null
    $exists = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if (-not $exists) {
        & codex mcp add scratchjr -- $NodePath $ServerFile
        if ($LASTEXITCODE -ne 0) { throw 'Codex registration failed' }
    } else { Write-Output 'Codex scratchjr entry already exists; preserved.' }
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
    if (-not $exists) {
        & claude.cmd mcp add --scope user scratchjr -- $NodePath $ServerFile
        if ($LASTEXITCODE -ne 0) { throw 'Claude Code registration failed' }
    } else { Write-Output 'Claude Code scratchjr entry already exists; preserved.' }
} else { Write-Warning 'Claude Code CLI not found; Claude Desktop is configured.' }
