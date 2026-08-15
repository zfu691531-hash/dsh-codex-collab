[CmdletBinding()]
param(
    [string]$ProfileName = 'web',
    [string]$DshBaseUrl = 'http://127.0.0.1:3080',
    [switch]$ForceSkill,
    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Resolve-NativeCommand {
    param([Parameter(Mandatory = $true)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) { return $null }
    return $command.Source
}

function Resolve-NodeCommand {
    $node = Resolve-NativeCommand -Name 'node'
    if ($node) { return $node }
    $runtimeRoot = Join-Path $env:LOCALAPPDATA 'DeepSeekHarness\runtime'
    if (Test-Path -LiteralPath $runtimeRoot) {
        $candidate = Get-ChildItem -LiteralPath $runtimeRoot -Directory -Filter 'node-*-win-x64' |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'node.exe' } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
        if ($candidate) { return $candidate }
    }
    return $null
}

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$NativeArguments,
        [Parameter(Mandatory = $true)][string]$Label
    )
    & $FilePath @NativeArguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "$Label failed with exit code $exitCode" }
}

function Get-CodexHome {
    if ($env:CODEX_HOME) { return [IO.Path]::GetFullPath($env:CODEX_HOME) }
    return [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.codex'))
}

function Get-DshHome {
    if ($env:DSH_HOME) { return [IO.Path]::GetFullPath($env:DSH_HOME) }
    return [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.dsh'))
}

function Get-VirtualStoreMaxLength {
    param([Parameter(Mandatory = $true)][string]$ProfilePath)
    $modulesFile = Join-Path $ProfilePath 'node_modules\.modules.yaml'
    if (-not (Test-Path -LiteralPath $modulesFile)) { return $null }
    $raw = Get-Content -LiteralPath $modulesFile -Raw -Encoding UTF8
    $match = [regex]::Match($raw, '["'']?virtualStoreDirMaxLength["'']?\s*[:=]\s*["'']?(\d+)')
    if ($match.Success) { return $match.Groups[1].Value }
    return $null
}

$bundleRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$packages = @(Get-ChildItem -LiteralPath $bundleRoot -File -Filter 'dsh-codex-collab-*.tgz')
if ($packages.Count -ne 1) { throw "Expected exactly one dsh-codex-collab TGZ beside install.ps1; found $($packages.Count)" }
$packagePath = $packages[0].FullName
$dshCommand = Resolve-NativeCommand -Name 'dsh'
if (-not $dshCommand) { throw 'DSH_NOT_FOUND: install DeepSeek Harness and ensure dsh is on PATH' }
$nodeCommand = Resolve-NodeCommand
if (-not $nodeCommand) { throw 'NODE_NOT_FOUND: no system Node.js or DeepSeek Harness Node runtime was found' }

$codexHome = Get-CodexHome
$dshHome = Get-DshHome
$profilePath = Join-Path (Join-Path $dshHome 'profiles') $ProfileName
$stablePackageDirectory = Join-Path (Join-Path $dshHome 'packages') 'dsh-codex-collab'
$stablePackagePath = Join-Path $stablePackageDirectory $packages[0].Name
$installedRoot = Join-Path (Join-Path $profilePath 'node_modules') 'dsh-codex-collab'
$serverPath = Join-Path $installedRoot 'dist\codex-mcp-server.js'
$configPath = Join-Path $codexHome 'config.toml'
$configurator = Join-Path $bundleRoot 'configure-codex.mjs'
$sourceSkill = Join-Path $bundleRoot 'codex-skill\dsh-collab\SKILL.md'
$targetSkillDirectory = Join-Path (Join-Path $codexHome 'skills') 'dsh-collab'
$targetSkill = Join-Path $targetSkillDirectory 'SKILL.md'

foreach ($required in @($configurator, $sourceSkill)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Bundle file is missing: $required" }
}

if (Test-Path -LiteralPath $targetSkill -PathType Leaf) {
    $sourceHash = (Get-FileHash -LiteralPath $sourceSkill -Algorithm SHA256).Hash
    $targetHash = (Get-FileHash -LiteralPath $targetSkill -Algorithm SHA256).Hash
    if ($sourceHash -ne $targetHash -and -not $ForceSkill) {
        throw "CODEX_SKILL_CONFLICT: $targetSkill already exists and differs. Re-run with -ForceSkill to back it up and install this version."
    }
}

$checkArgs = @($configurator, 'check-add', $configPath, $nodeCommand, $serverPath, $installedRoot, $DshBaseUrl)
Invoke-NativeChecked -FilePath $nodeCommand -NativeArguments $checkArgs -Label 'Codex MCP config preflight'

if ($DryRun) {
    Write-Output 'DRY_RUN_OK'
    Write-Output "Plugin package: $packagePath"
    Write-Output "Stable package: $stablePackagePath"
    Write-Output "DSH profile: $profilePath"
    Write-Output "Codex config: $configPath"
    Write-Output "Codex skill: $targetSkill"
    return
}

New-Item -ItemType Directory -Path $stablePackageDirectory -Force | Out-Null
Copy-Item -LiteralPath $packagePath -Destination $stablePackagePath -Force

$dshArgs = @('plugin', '--profile', $ProfileName, 'add', $stablePackagePath)
$maxLength = Get-VirtualStoreMaxLength -ProfilePath $profilePath
if ($maxLength) { $dshArgs += "--config.virtual-store-dir-max-length=$maxLength" }
Invoke-NativeChecked -FilePath $dshCommand -NativeArguments $dshArgs -Label 'DSH plugin installation'

if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
    throw "DSH_PLUGIN_INCOMPLETE: companion server was not installed at $serverPath"
}

if (Test-Path -LiteralPath $targetSkill -PathType Leaf) {
    $sourceHash = (Get-FileHash -LiteralPath $sourceSkill -Algorithm SHA256).Hash
    $targetHash = (Get-FileHash -LiteralPath $targetSkill -Algorithm SHA256).Hash
    if ($sourceHash -ne $targetHash) {
        $backup = "$targetSkillDirectory.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $targetSkillDirectory -Destination $backup -Recurse -Force
        Write-Output "Existing Codex skill backed up to $backup"
    }
}
New-Item -ItemType Directory -Path $targetSkillDirectory -Force | Out-Null
Copy-Item -LiteralPath $sourceSkill -Destination $targetSkill -Force

$addArgs = @($configurator, 'add', $configPath, $nodeCommand, $serverPath, $installedRoot, $DshBaseUrl)
Invoke-NativeChecked -FilePath $nodeCommand -NativeArguments $addArgs -Label 'Codex MCP registration'

Write-Output ''
Write-Output 'INSTALL_OK'
Write-Output "DSH profile: $ProfileName"
Write-Output "Codex config: $configPath"
Write-Output "Codex skill: $targetSkill"
Write-Output 'Restart DeepSeek Harness and Codex, then run doctor.cmd.'
