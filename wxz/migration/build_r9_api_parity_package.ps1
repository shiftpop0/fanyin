param(
    [string]$PackageDate = "20260830-r9"
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$BuildRoot = Join-Path $PSScriptRoot "build"
$PackagesRoot = Join-Path $PSScriptRoot "packages"
$PackageName = "fanyin-new4.1-incremental-$PackageDate"
$StageRoot = Join-Path $BuildRoot ("{0}-{1}" -f $PackageName, (Get-Date -Format "HHmmss"))
$PackageRoot = Join-Path $StageRoot $PackageName
$PayloadRoot = Join-Path $PackageRoot "payload"
$MigrationRoot = Join-Path $PackageRoot "migration"
$ArchivePath = Join-Path $PackagesRoot ("$PackageName.tar.gz")
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

if (Test-Path -LiteralPath $ArchivePath) {
    throw "Archive already exists; refusing to overwrite: $ArchivePath"
}

New-Item -ItemType Directory -Path $PayloadRoot -Force | Out-Null
New-Item -ItemType Directory -Path $MigrationRoot -Force | Out-Null
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

$PayloadFiles = @(
    "tailect/core/audio_input.py",
    "tailect/core/inference_engine.py",
    "tailect/core/v1_adapter.py",
    "tailect/core/v1_contract.py",
    "tailect/README.md",
    "spyware-translator-v4.1/spyware-translator-v4.1.user.js",
    "spyware-translator-v4.1/tests/userscript_static_test.mjs"
)
$PayloadFiles | ForEach-Object { Copy-RepoFile -RelativePath $_ -DestinationRoot $PayloadRoot }

@(
    "apply_r9_api_parity.sh",
    "rollback_r9_api_parity.sh",
    "acceptance_r9_api_parity.sh"
) | ForEach-Object {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $_) -Destination $MigrationRoot
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "README_r9_api_parity.md") `
    -Destination (Join-Path $MigrationRoot "README.md")

# Force Linux shell scripts to UTF-8 without BOM and LF only.
foreach ($ScriptName in @(
    "apply_r9_api_parity.sh",
    "rollback_r9_api_parity.sh",
    "acceptance_r9_api_parity.sh"
)) {
    $ScriptPath = Join-Path $MigrationRoot $ScriptName
    $ScriptText = [System.IO.File]::ReadAllText($ScriptPath)
    $ScriptText = $ScriptText.Replace("`r`n", "`n").Replace("`r", "`n")
    [System.IO.File]::WriteAllText($ScriptPath, $ScriptText, $Utf8NoBom)
}

$ServerAudioInput = Join-Path $PayloadRoot "tailect\core\audio_input.py"
$ServerAudioText = [System.IO.File]::ReadAllText($ServerAudioInput)
if ($ServerAudioText -match 'pan=mono|audio channel merge|_mono\.wav|merged .*channels to mono') {
    throw "R9 payload contains rejected R8 server-side downmix logic: $ServerAudioInput"
}
$InferenceText = [System.IO.File]::ReadAllText((Join-Path $PayloadRoot "tailect\core\inference_engine.py"))
if ($InferenceText -notmatch 'def transcribe_diarized_segments\(') {
    throw "R9 shared diarized ASR core is missing"
}
$AdapterText = [System.IO.File]::ReadAllText((Join-Path $PayloadRoot "tailect\core\v1_adapter.py"))
if ($AdapterText -notmatch 'service\.transcribe_diarized_segments\(') {
    throw "R9 v1 adapter is not connected to the shared core"
}

$ResolvedCommit = (git -C $RepositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $ResolvedCommit) {
    throw "Unable to resolve current Git commit"
}
$SourceStatus = git -C $RepositoryRoot status --short -- $PayloadFiles
[System.IO.File]::WriteAllText(
    (Join-Path $PackageRoot "SOURCE_COMMIT.txt"),
    "$ResolvedCommit`n",
    $Utf8NoBom
)
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
