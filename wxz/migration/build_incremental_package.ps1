param(
    [string]$PackageDate = "20260829-r5"
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$BuildRoot = Join-Path $PSScriptRoot "build"
$PackagesRoot = Join-Path $PSScriptRoot "packages"
$PackageName = "fanyin-new4.1-incremental-$PackageDate"
$StageRoot = Join-Path $BuildRoot ("{0}-{1}" -f $PackageName, (Get-Date -Format "HHmmss"))
$PackageRoot = Join-Path $StageRoot $PackageName
$PayloadRoot = Join-Path $PackageRoot "payload"
$ArchivePath = Join-Path $PackagesRoot ("$PackageName.tar.gz")

if (Test-Path -LiteralPath $ArchivePath) {
    throw "Archive already exists; refusing to overwrite: $ArchivePath"
}

New-Item -ItemType Directory -Path $PayloadRoot -Force | Out-Null
New-Item -ItemType Directory -Path $PackagesRoot -Force | Out-Null

function Copy-RepoFile {
    param([string]$RelativePath, [string]$DestinationRoot)
    $Source = Join-Path $RepositoryRoot $RelativePath
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Required file not found: $Source"
    }
    $Destination = Join-Path $DestinationRoot $RelativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination
}

$CoreFiles = Get-ChildItem -LiteralPath (Join-Path $RepositoryRoot "tailect\core") -Filter "*.py" -File
foreach ($File in $CoreFiles) {
    Copy-RepoFile -RelativePath ("tailect/core/{0}" -f $File.Name) -DestinationRoot $PayloadRoot
}

@(
    "tailect/unified_asr_diarization_transformer_offline.py",
    "tailect/config/audio_url_allowlist.json.example",
    "tailect/tests/__init__.py",
    "tailect/tests/test_v1_platform.py"
) | ForEach-Object { Copy-RepoFile -RelativePath $_ -DestinationRoot $PayloadRoot }

$AllowlistSource = Join-Path $RepositoryRoot "wxz\migration\production_config\audio_url_allowlist.json"
$AllowlistDestination = Join-Path $PayloadRoot "tailect\config\audio_url_allowlist.json"
New-Item -ItemType Directory -Path (Split-Path -Parent $AllowlistDestination) -Force | Out-Null
Copy-Item -LiteralPath $AllowlistSource -Destination $AllowlistDestination

$DeployDestination = Join-Path $PayloadRoot "wxz\deploy"
New-Item -ItemType Directory -Path $DeployDestination -Force | Out-Null
Copy-Item -Path (Join-Path $RepositoryRoot "wxz\deploy\*") -Destination $DeployDestination -Recurse

$MigrationPayloadDestination = Join-Path $PayloadRoot "wxz\migration"
New-Item -ItemType Directory -Path $MigrationPayloadDestination -Force | Out-Null
@(
    "preflight_new4_1.sh",
    "acceptance_new4_1.sh",
    "rollback_to_old.sh"
) | ForEach-Object {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $_) -Destination $MigrationPayloadDestination
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "迁移包使用说明.md") `
    -Destination (Join-Path $MigrationPayloadDestination "README.md")

$UserscriptDestination = Join-Path $PayloadRoot "spyware-translator-v4.1"
New-Item -ItemType Directory -Path $UserscriptDestination -Force | Out-Null
Copy-Item -Path (Join-Path $RepositoryRoot "spyware-translator-v4.1\*") `
    -Destination $UserscriptDestination -Recurse

$TopMigration = Join-Path $PackageRoot "migration"
New-Item -ItemType Directory -Path $TopMigration -Force | Out-Null
@(
    "prepare_release.sh",
    "preflight_new4_1.sh",
    "acceptance_new4_1.sh",
    "rollback_to_old.sh"
) | ForEach-Object {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $_) -Destination $TopMigration
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "迁移包使用说明.md") `
    -Destination (Join-Path $TopMigration "README.md")

$ManifestLines = Get-ChildItem -LiteralPath $PackageRoot -File -Recurse |
    Sort-Object FullName |
    ForEach-Object {
        $Relative = $_.FullName.Substring($PackageRoot.Length + 1).Replace("\", "/")
        $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
        "$Hash  $Relative"
    }
$ManifestText = ($ManifestLines -join "`n") + "`n"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText(
    (Join-Path $PackageRoot "SHA256SUMS"),
    $ManifestText,
    $Utf8NoBom
)

tar -czf $ArchivePath -C $StageRoot $PackageName
if ($LASTEXITCODE -ne 0) {
    throw "tar failed with exit code $LASTEXITCODE"
}

$ArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash.ToLowerInvariant()
$ArchiveSize = (Get-Item -LiteralPath $ArchivePath).Length
Write-Output "PACKAGE=$ArchivePath"
Write-Output "BYTES=$ArchiveSize"
Write-Output "SHA256=$ArchiveHash"
Write-Output "STAGE_RETAINED=$StageRoot"
