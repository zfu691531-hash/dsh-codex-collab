[CmdletBinding()]
param(
    [string]$ProfileName = 'web',
    [string]$DshBaseUrl = 'http://127.0.0.1:3080'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Resolve-CommandPath {
    param([Parameter(Mandatory = $true)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) { return $null }
    return $command.Source
}

function Resolve-NodeCommand {
    $node = Resolve-CommandPath -Name 'node'
    if ($node) { return $node }
    $runtimeRoot = Join-Path $env:LOCALAPPDATA 'DeepSeekHarness\runtime'
    if (Test-Path -LiteralPath $runtimeRoot) {
        return Get-ChildItem -LiteralPath $runtimeRoot -Directory -Filter 'node-*-win-x64' |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'node.exe' } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
    }
    return $null
}

$dshCommand = Resolve-CommandPath -Name 'dsh'
$nodeCommand = Resolve-NodeCommand
if (-not $dshCommand) { throw 'DSH_NOT_FOUND' }
if (-not $nodeCommand) { throw 'NODE_NOT_FOUND' }
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profilePath = Join-Path (Join-Path $dshHome 'profiles') $ProfileName
$installedRoot = Join-Path (Join-Path $profilePath 'node_modules') 'dsh-codex-collab'
$serverPath = Join-Path $installedRoot 'dist\codex-mcp-server.js'
$configPath = Join-Path $codexHome 'config.toml'
$skillPath = Join-Path (Join-Path (Join-Path $codexHome 'skills') 'dsh-collab') 'SKILL.md'
$smokeScript = Join-Path $PSScriptRoot 'mcp-smoke.mjs'

$listArgs = @('plugin', '--profile', $ProfileName, 'list', '--depth', '0')
$pluginList = & $dshCommand @listArgs 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw 'DSH_PLUGIN_LIST_FAILED' }
if ($pluginList -notmatch 'dsh-codex-collab@') { throw 'DSH_PLUGIN_NOT_INSTALLED' }
Write-Output (($pluginList -split "`r?`n") | Where-Object { $_ -match 'dsh-codex-collab@' })

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'CODEX_CONFIG_NOT_FOUND' }
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
if ($config -notmatch '(?m)^# >>> dsh-codex-collab managed MCP >>>$') { throw 'CODEX_MCP_NOT_CONFIGURED' }
if (-not (Test-Path -LiteralPath $skillPath -PathType Leaf)) { throw 'CODEX_SKILL_NOT_INSTALLED' }
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw 'MCP_SERVER_NOT_INSTALLED' }

try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "$DshBaseUrl/" -TimeoutSec 5
    if ($health.StatusCode -ne 200) { throw "HTTP $($health.StatusCode)" }
    Write-Output "DSH_HTTP_OK $($health.StatusCode)"
} catch {
    throw "DSH_UNAVAILABLE: $($_.Exception.Message). Restart DeepSeek Harness and retry."
}

$smokeArgs = @($smokeScript, $nodeCommand, $serverPath, $installedRoot, $DshBaseUrl)
& $nodeCommand @smokeArgs
if ($LASTEXITCODE -ne 0) { throw "MCP companion smoke test failed with exit code $LASTEXITCODE" }

Write-Output 'DOCTOR_OK'
Write-Output 'Open a new Codex task and say: Collaborate with DSH on this task.'
