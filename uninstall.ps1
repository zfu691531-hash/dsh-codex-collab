[CmdletBinding()]
param([string]$ProfileName = 'web')

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

function Get-VirtualStoreMaxLength {
    param([Parameter(Mandatory = $true)][string]$ProfilePath)
    $modulesFile = Join-Path $ProfilePath 'node_modules\.modules.yaml'
    if (-not (Test-Path -LiteralPath $modulesFile)) { return $null }
    $raw = Get-Content -LiteralPath $modulesFile -Raw -Encoding UTF8
    $match = [regex]::Match($raw, '["'']?virtualStoreDirMaxLength["'']?\s*[:=]\s*["'']?(\d+)')
    if ($match.Success) { return $match.Groups[1].Value }
    return $null
}

$nodeCommand = Resolve-NodeCommand
if (-not $nodeCommand) { throw 'NODE_NOT_FOUND' }
$dshCommand = Resolve-CommandPath -Name 'dsh'
$codexHome = if ($env:CODEX_HOME) { [IO.Path]::GetFullPath($env:CODEX_HOME) } else { [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.codex')) }
$dshHome = if ($env:DSH_HOME) { [IO.Path]::GetFullPath($env:DSH_HOME) } else { [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.dsh')) }
$configPath = Join-Path $codexHome 'config.toml'
$configurator = Join-Path $PSScriptRoot 'configure-codex.mjs'
$sourceSkill = Join-Path $PSScriptRoot 'codex-skill\dsh-collab\SKILL.md'
$targetSkillDirectory = Join-Path (Join-Path $codexHome 'skills') 'dsh-collab'
$targetSkill = Join-Path $targetSkillDirectory 'SKILL.md'
$profilePath = Join-Path (Join-Path $dshHome 'profiles') $ProfileName
$packageFiles = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter 'dsh-codex-collab-*.tgz')
$stablePackageDirectory = Join-Path (Join-Path $dshHome 'packages') 'dsh-codex-collab'
$stablePackagePath = if ($packageFiles.Count -eq 1) { Join-Path $stablePackageDirectory $packageFiles[0].Name } else { $null }

$pluginList = $null
if ($dshCommand) {
    $listArgs = @('plugin', '--profile', $ProfileName, 'list', '--depth', '0')
    $pluginList = & $dshCommand @listArgs 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "DSH_PLUGIN_LIST_FAILED: $($pluginList.Trim())" }
}

& $nodeCommand @($configurator, 'remove', $configPath)
if ($LASTEXITCODE -ne 0) { throw "Codex MCP removal failed with exit code $LASTEXITCODE" }

if ((Test-Path -LiteralPath $sourceSkill -PathType Leaf) -and (Test-Path -LiteralPath $targetSkill -PathType Leaf)) {
    $sourceHash = (Get-FileHash -LiteralPath $sourceSkill -Algorithm SHA256).Hash
    $targetHash = (Get-FileHash -LiteralPath $targetSkill -Algorithm SHA256).Hash
    if ($sourceHash -eq $targetHash) {
        $skillsRoot = [IO.Path]::GetFullPath((Join-Path $codexHome 'skills'))
        $resolvedTarget = [IO.Path]::GetFullPath($targetSkillDirectory)
        if (-not $resolvedTarget.StartsWith("$skillsRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove skill outside $skillsRoot"
        }
        Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
        Write-Output 'CODEX_SKILL_REMOVED'
    } else {
        Write-Warning "Codex skill was modified and was preserved at $targetSkillDirectory"
    }
}

if ($dshCommand) {
    if ($pluginList -match 'dsh-codex-collab@') {
        $removeArgs = @('plugin', '--profile', $ProfileName, 'remove', 'dsh-codex-collab')
        $maxLength = Get-VirtualStoreMaxLength -ProfilePath $profilePath
        $previousMaxLength = [Environment]::GetEnvironmentVariable('PNPM_CONFIG_VIRTUAL_STORE_DIR_MAX_LENGTH', 'Process')
        try {
            if ($maxLength) {
                # pnpm 11 compares this value strictly with the numeric value in .modules.yaml;
                # the --config.* CLI form reaches pnpm as a string on Windows.
                $env:PNPM_CONFIG_VIRTUAL_STORE_DIR_MAX_LENGTH = $maxLength
            }
            & $dshCommand @removeArgs
            if ($LASTEXITCODE -ne 0) { throw "DSH plugin removal failed with exit code $LASTEXITCODE" }
        }
        finally {
            if ($null -eq $previousMaxLength) {
                Remove-Item Env:PNPM_CONFIG_VIRTUAL_STORE_DIR_MAX_LENGTH -ErrorAction SilentlyContinue
            } else {
                $env:PNPM_CONFIG_VIRTUAL_STORE_DIR_MAX_LENGTH = $previousMaxLength
            }
        }
        if ($stablePackagePath -and (Test-Path -LiteralPath $stablePackagePath -PathType Leaf)) {
            $packagesRoot = [IO.Path]::GetFullPath((Join-Path $dshHome 'packages'))
            $resolvedPackage = [IO.Path]::GetFullPath($stablePackagePath)
            if (-not $resolvedPackage.StartsWith("$packagesRoot\", [StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to remove package outside $packagesRoot"
            }
            Remove-Item -LiteralPath $resolvedPackage -Force
            if ((Test-Path -LiteralPath $stablePackageDirectory -PathType Container) -and
                @(Get-ChildItem -LiteralPath $stablePackageDirectory -Force).Count -eq 0) {
                Remove-Item -LiteralPath $stablePackageDirectory -Force
            }
            Write-Output 'STABLE_PLUGIN_PACKAGE_REMOVED'
        }
    }
} else {
    Write-Warning 'dsh was not found; the DSH plugin was not removed'
}

Write-Output 'UNINSTALL_OK'
Write-Output 'Restart DeepSeek Harness and Codex.'
