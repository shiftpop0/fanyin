param(
    [string]$PackageDate = "20260830-r8",
    [string]$SourceCommit = "HEAD"
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$BuildRoot = Join-Path $PSScriptRoot "build"
$PackagesRoot = Join-Path $PSScriptRoot "packages"
$PackageName = "fanyin-new4.1-incremental-$PackageDate"
$StageRoot = Join-Path $BuildRoot ("{0}-{1}" -f $PackageName, (Get-Date -Format "HHmmss"))
$SnapshotRoot = Join-Path $StageRoot "snapshot"
$PackageRoot = Join-Path $StageRoot $PackageName
$PayloadRoot = Join-Path $PackageRoot "payload"
$MigrationRoot = Join-Path $PackageRoot "migration"
$ArchivePath = Join-Path $PackagesRoot ("$PackageName.tar.gz")
$SnapshotTar = Join-Path $StageRoot "source-commit.tar"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

if (Test-Path -LiteralPath $ArchivePath) {
    throw "Archive already exists; refusing to overwrite: $ArchivePath"
}

$ResolvedCommit = (git -C $RepositoryRoot rev-parse $SourceCommit).Trim()
if ($LASTEXITCODE -ne 0 -or -not $ResolvedCommit) {
    throw "Unable to resolve source commit: $SourceCommit"
}

New-Item -ItemType Directory -Path $SnapshotRoot -Force | Out-Null
New-Item -ItemType Directory -Path $PayloadRoot -Force | Out-Null
New-Item -ItemType Directory -Path $MigrationRoot -Force | Out-Null
New-Item -ItemType Directory -Path $PackagesRoot -Force | Out-Null

$SnapshotFiles = @(
    "tailect/core/audio_input.py",
    "tailect/core/v1_router.py",
    "wxz/migration/apply_r8_stereo_downmix.sh",
    "wxz/migration/rollback_r8_stereo_downmix.sh",
    "wxz/migration/README_r8_stereo_downmix.md"
)

git -C $RepositoryRoot archive --format=tar --output=$SnapshotTar $ResolvedCommit -- $SnapshotFiles
if ($LASTEXITCODE -ne 0) {
    throw "git archive failed for source commit $ResolvedCommit"
}
tar -xf $SnapshotTar -C $SnapshotRoot
if ($LASTEXITCODE -ne 0) {
    throw "Unable to extract committed source snapshot"
}

foreach ($RelativePath in @("tailect/core/audio_input.py", "tailect/core/v1_router.py")) {
    $Source = Join-Path $SnapshotRoot $RelativePath
    $Destination = Join-Path $PayloadRoot $RelativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination
}

Copy-Item -LiteralPath (Join-Path $SnapshotRoot "wxz/migration/apply_r8_stereo_downmix.sh") `
    -Destination (Join-Path $MigrationRoot "apply_r8_stereo_downmix.sh")
Copy-Item -LiteralPath (Join-Path $SnapshotRoot "wxz/migration/rollback_r8_stereo_downmix.sh") `
    -Destination (Join-Path $MigrationRoot "rollback_r8_stereo_downmix.sh")
Copy-Item -LiteralPath (Join-Path $SnapshotRoot "wxz/migration/README_r8_stereo_downmix.md") `
    -Destination (Join-Path $MigrationRoot "README.md")

# Git for Windows may store/export CRLF when core.autocrlf is enabled. Force
# Linux shell scripts in the migration archive to UTF-8 without BOM and LF only.
foreach ($ScriptName in @("apply_r8_stereo_downmix.sh", "rollback_r8_stereo_downmix.sh")) {
    $ScriptPath = Join-Path $MigrationRoot $ScriptName
    $ScriptText = [System.IO.File]::ReadAllText($ScriptPath)
    $ScriptText = $ScriptText.Replace("`r`n", "`n").Replace("`r", "`n")
    [System.IO.File]::WriteAllText($ScriptPath, $ScriptText, $Utf8NoBom)
}

[System.IO.File]::WriteAllText(
    (Join-Path $PackageRoot "SOURCE_COMMIT.txt"),
    "$ResolvedCommit`n",
    $Utf8NoBom
)

$ManifestLines = Get-ChildItem -LiteralPath $PackageRoot -File -Recurse |
    Sort-Object FullName |
    ForEach-Object {
        $Relative = $_.FullName.Substring($PackageRoot.Length + 1).Replace("\", "/")
        $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
        "$Hash  $Relative"
    }
[System.IO.File]::WriteAllText(
    (Join-Path $PackageRoot "SHA256SUMS"),
    (($ManifestLines -join "`n") + "`n"),
    $Utf8NoBom
)

tar -czf $ArchivePath -C $StageRoot $PackageName
if ($LASTEXITCODE -ne 0) {
    throw "tar failed with exit code $LASTEXITCODE"
}

$ArchiveEntries = @(tar -tzf $ArchivePath)
if ($LASTEXITCODE -ne 0) {
    throw "Unable to list the generated archive"
}
$NonAsciiEntries = @($ArchiveEntries | Where-Object { $_ -match '[^\x00-\x7F]' })
if ($NonAsciiEntries.Count -gt 0) {
    throw "Archive contains non-ASCII paths: $($NonAsciiEntries -join ', ')"
}

$ArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash.ToLowerInvariant()
$ArchiveSize = (Get-Item -LiteralPath $ArchivePath).Length
Write-Output "PACKAGE=$ArchivePath"
Write-Output "BYTES=$ArchiveSize"
Write-Output "SHA256=$ArchiveHash"
Write-Output "SOURCE_COMMIT=$ResolvedCommit"
Write-Output "STAGE_RETAINED=$StageRoot"
