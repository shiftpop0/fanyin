param(
    [string]$PackageDate = "20260831-r1"
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$BuildRoot = Join-Path $PSScriptRoot "build"
$PackagesRoot = Join-Path $PSScriptRoot "packages"
$PackageName = "fanyin-new4.1-web-console-$PackageDate"
$StageRoot = Join-Path $BuildRoot ("{0}-{1}" -f $PackageName, (Get-Date -Format "HHmmss"))
$PackageRoot = Join-Path $StageRoot $PackageName
$PayloadRoot = Join-Path $PackageRoot "payload"
$MigrationRoot = Join-Path $PackageRoot "migration"
$ArchivePath = Join-Path $PackagesRoot ("$PackageName.tar.gz")
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

if (Test-Path -LiteralPath $ArchivePath) {
    throw "Archive already exists; refusing to overwrite: $ArchivePath"
}

$WebDist = Join-Path $RepositoryRoot "tailect\web\dist"
if (-not (Test-Path -LiteralPath (Join-Path $WebDist "index.html") -PathType Leaf)) {
    throw "Web dist is missing; run pnpm build first: $WebDist"
}
$WebAssets = @(Get-ChildItem -LiteralPath (Join-Path $WebDist "assets") -File)
if ($WebAssets.Count -eq 0) {
    throw "Web assets are missing: $WebDist\assets"
}

New-Item -ItemType Directory -Path $PayloadRoot -Force | Out-Null
New-Item -ItemType Directory -Path $MigrationRoot -Force | Out-Null
New-Item -ItemType Directory -Path $PackagesRoot -Force | Out-Null

$PayloadWebRoot = Join-Path $PayloadRoot "tailect\web\dist"
New-Item -ItemType Directory -Path $PayloadWebRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $WebDist "index.html") -Destination $PayloadWebRoot
Copy-Item -LiteralPath (Join-Path $WebDist "assets") -Destination $PayloadWebRoot -Recurse

$TrackedPayloadFiles = @(
    "wxz/deploy/nginx_platform_8885.conf",
    "wxz/deploy/proxy_params.conf",
    "wxz/deploy/run_v4_1_single_4090.sh"
)
foreach ($RelativePath in $TrackedPayloadFiles) {
    $Source = Join-Path $RepositoryRoot $RelativePath
    $Destination = Join-Path $PayloadRoot $RelativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination
}

@("apply_web_console.sh", "rollback_web_console.sh") | ForEach-Object {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $_) -Destination $MigrationRoot
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "README_web_console.md") `
    -Destination (Join-Path $MigrationRoot "README.md")

foreach ($ScriptName in @("apply_web_console.sh", "rollback_web_console.sh")) {
    $ScriptPath = Join-Path $MigrationRoot $ScriptName
    $ScriptText = [System.IO.File]::ReadAllText($ScriptPath).Replace("`r`n", "`n").Replace("`r", "`n")
    [System.IO.File]::WriteAllText($ScriptPath, $ScriptText, $Utf8NoBom)
}

$ResolvedCommit = (git -C $RepositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $ResolvedCommit) {
    throw "Unable to resolve current Git commit"
}
$SourceStatus = git -C $RepositoryRoot status --short -- tailect/web wxz/deploy wxz/migration
[System.IO.File]::WriteAllText((Join-Path $PackageRoot "SOURCE_COMMIT.txt"), "$ResolvedCommit`n", $Utf8NoBom)
[System.IO.File]::WriteAllText(
    (Join-Path $PackageRoot "SOURCE_STATUS.txt"),
    (($SourceStatus -join "`n") + "`n"),
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
    throw "Unable to list generated archive"
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
