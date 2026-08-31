param(
    [string]$NodeExe = $env:FANYIN_NODE_EXE,
    [string]$OutputRoot = ""
)

$ErrorActionPreference = "Stop"

$helperDir = $PSScriptRoot
$translatorDir = Split-Path -Parent $helperDir
$tempDir = Join-Path $translatorDir "temp"
if (-not $OutputRoot) {
    $OutputRoot = Join-Path $tempDir "offline_client_package"
}

if (-not $NodeExe) {
    $bundledNode = Join-Path $helperDir "runtime\node.exe"
    if (Test-Path -LiteralPath $bundledNode) {
        $NodeExe = $bundledNode
    } else {
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($nodeCommand) {
            $NodeExe = $nodeCommand.Source
        }
    }
}

if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe)) {
    throw "Node.js x64 executable was not found. Set FANYIN_NODE_EXE to an offline node.exe path."
}

$NodeExe = (Resolve-Path -LiteralPath $NodeExe).Path
$nodeArch = (& $NodeExe -p "process.arch").Trim()
$nodeVersion = (& $NodeExe --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeArch -ne "x64") {
    throw "The offline client package requires Windows x64 Node.js. Detected: $nodeArch"
}

$major = [int](($nodeVersion -replace "^v", "").Split(".")[0])
if ($major -lt 18) {
    throw "Node.js 18 or later is required. Detected: $nodeVersion"
}

$outputRootFull = [System.IO.Path]::GetFullPath($OutputRoot)
$packageName = "spyware_translator_v41_offline_client_win_x64_{0}" -f (Get-Date -Format "yyyyMMdd_HHmmss")
$packageDir = Join-Path $outputRootFull $packageName
$payloadDir = Join-Path $packageDir "spyware-translator-v4.1"
$payloadHelperDir = Join-Path $payloadDir "local_helper"
$runtimeDir = Join-Path $payloadHelperDir "runtime"

New-Item -ItemType Directory -Force -Path $outputRootFull | Out-Null
if (Test-Path -LiteralPath $packageDir) {
    throw "Timestamped output directory already exists; rerun the build: $packageDir"
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
Copy-Item -LiteralPath (Join-Path $translatorDir "spyware-translator-v4.1.user.js") -Destination $payloadDir
Copy-Item -LiteralPath (Join-Path $helperDir "local_csv_helper.mjs") -Destination $payloadHelperDir
$startupBat = Get-ChildItem -LiteralPath $helperDir -File -Filter "*CSV*.bat" |
    Where-Object { $_.Name -notlike "*offline*" } |
    Select-Object -First 1
if (-not $startupBat) {
    throw "The local helper startup BAT was not found."
}
Copy-Item -LiteralPath $startupBat.FullName `
    -Destination (Join-Path $payloadHelperDir "start_local_csv_helper.bat")
$helperDocumentation = Join-Path $translatorDir "..\wxz\docs\本机CSV助手说明.md"
if (-not (Test-Path -LiteralPath $helperDocumentation)) {
    throw "Local helper documentation was not found: $helperDocumentation"
}
Copy-Item -LiteralPath $helperDocumentation -Destination (Join-Path $payloadHelperDir "README.md")
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $runtimeDir "node.exe")

$licenseCandidates = @(
    (Join-Path (Split-Path -Parent $NodeExe) "LICENSE"),
    (Join-Path (Split-Path -Parent $NodeExe) "LICENSE.txt")
)
$licenseSource = $licenseCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($licenseSource) {
    Copy-Item -LiteralPath $licenseSource -Destination (Join-Path $runtimeDir "NODE_LICENSE.txt")
} else {
    @"
Bundled runtime: Node.js $nodeVersion for Windows x64
Node.js is distributed under its applicable open-source licenses.
Official license information: https://github.com/nodejs/node/blob/main/LICENSE
"@ | Set-Content -LiteralPath (Join-Path $runtimeDir "NODE_RUNTIME_NOTICE.txt") -Encoding UTF8
}

$nodeHash = (Get-FileHash -LiteralPath (Join-Path $runtimeDir "node.exe") -Algorithm SHA256).Hash
@"
Spyware Translator offline userscript client package
Build date: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Node version: $nodeVersion
Node architecture: $nodeArch
Node SHA256: $nodeHash

Usage:
1. Copy the spyware-translator-v4.1 directory to the userscript computer.
2. Double-click local_helper\start_local_csv_helper.bat.
3. Import spyware-translator-v4.1.user.js into Tampermonkey.
4. No Node.js installation or network access is required.
"@ | Set-Content -LiteralPath (Join-Path $packageDir "PACKAGE_INFO.txt") -Encoding UTF8

$zipPath = "$packageDir.zip"
if (Test-Path -LiteralPath $zipPath) {
    throw "Timestamped ZIP already exists; rerun the build: $zipPath"
}

Start-Sleep -Milliseconds 500
$tarCommand = Get-Command tar.exe -ErrorAction SilentlyContinue
if ($tarCommand) {
    & $tarCommand.Source -a -c -f $zipPath -C $packageDir .
    if ($LASTEXITCODE -ne 0) {
        throw "tar.exe failed to create the offline ZIP. Exit code: $LASTEXITCODE"
    }
} else {
    Compress-Archive -Path (Join-Path $packageDir "*") -DestinationPath $zipPath -CompressionLevel Optimal -ErrorAction Stop
}

if (-not (Test-Path -LiteralPath $zipPath)) {
    throw "The offline ZIP was not created."
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $nodeEntry = $archive.Entries |
        Where-Object { $_.FullName.Replace("\", "/").EndsWith("spyware-translator-v4.1/local_helper/runtime/node.exe") } |
        Select-Object -First 1
    if (-not $nodeEntry -or $nodeEntry.Length -ne (Get-Item -LiteralPath $NodeExe).Length) {
        throw "The offline ZIP does not contain the complete portable node.exe."
    }
} finally {
    $archive.Dispose()
}

Write-Host ""
Write-Host "Offline package created:"
Write-Host "  Folder: $packageDir"
Write-Host "  ZIP:    $zipPath"
Write-Host "  Node:   $nodeVersion $nodeArch"
Write-Host "  SHA256: $nodeHash"
