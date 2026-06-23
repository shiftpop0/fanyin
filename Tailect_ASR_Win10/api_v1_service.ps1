param(
  [ValidateSet("start", "stop", "status")]
  [string]$Action = "status",
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"

$RootDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $RootDir "api_v1_config.json"
}
if (-not [System.IO.Path]::IsPathRooted($ConfigPath)) {
  $currentCandidate = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $ConfigPath))
  if (Test-Path -LiteralPath $currentCandidate) {
    $ConfigPath = $currentCandidate
  } else {
    $ConfigPath = Join-Path $RootDir $ConfigPath
  }
}
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)

$PythonDir = Join-Path $RootDir "WPy64-312101\python"
$PythonExe = Join-Path $PythonDir "python.exe"
$RuntimeDir = Join-Path $RootDir "outputs\api_runtime"
$LogDir = Join-Path $RootDir "outputs\logs"
$PidFile = Join-Path $RuntimeDir "api_v1.pid"
$StopFile = Join-Path $RuntimeDir "api_v1.last_stop.txt"

$env:PATH = "$PythonDir;$PythonDir\Scripts;$RootDir\bin;$env:PATH"
$env:TAILECT_ROOT = $RootDir
$env:MODELSCOPE_CACHE = Join-Path $RootDir "models"
$env:TAILECT_SD_MODEL_PATH = Join-Path $RootDir "models\models\iic\speech_campplus_speaker-diarization_common"
$env:MODELSCOPE_OFFLINE = "1"
$env:HF_HUB_OFFLINE = "1"
$env:TRANSFORMERS_OFFLINE = "1"
$env:TRANSFORMERS_VERBOSITY = "error"
$env:PYTHONUNBUFFERED = "1"
$env:NO_PROXY = "127.0.0.1,localhost"
$env:no_proxy = "127.0.0.1,localhost"
$env:HTTP_PROXY = ""
$env:HTTPS_PROXY = ""
$env:ALL_PROXY = ""

function Read-ApiConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "API config file does not exist: $ConfigPath"
  }
  return Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-ConfigPort {
  param($Config)
  if ($null -ne $Config.port) {
    return [int]$Config.port
  }
  return 8885
}

function Get-ApiProcessFromPidFile {
  if (-not (Test-Path -LiteralPath $PidFile)) {
    return $null
  }
  $raw = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $pidValue = 0
  if (-not [int]::TryParse([string]$raw, [ref]$pidValue)) {
    return $null
  }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
  if ($null -eq $proc) {
    return $null
  }
  if ([string]$proc.CommandLine -notlike "*tailect_asr.cli.api_v1*") {
    return $null
  }
  return $proc
}

function Get-ListeningProcessId {
  param([int]$Port)
  try {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $conn) {
      return [int]$conn.OwningProcess
    }
  } catch {
    return $null
  }
  return $null
}

function Get-ProcessById {
  param([int]$ProcessId)
  return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Test-IsApiProcess {
  param($Process)
  return $null -ne $Process -and [string]$Process.CommandLine -like "*tailect_asr.cli.api_v1*"
}

function Get-HealthPayload {
  param([int]$Port)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
    if ([int]$response.StatusCode -ne 200) {
      return $null
    }
    return $response.Content | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Wait-ApiReady {
  param(
    [int]$ProcessId,
    [int]$Port,
    [int]$TimeoutSec = 180
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $proc = Get-ProcessById $ProcessId
    if ($null -eq $proc) {
      return $null
    }
    $health = Get-HealthPayload $Port
    if ($null -ne $health -and [string]$health.status -eq "ok") {
      return $health
    }
    Start-Sleep -Seconds 2
  }
  return $null
}

function Show-Status {
  $config = Read-ApiConfig
  $port = Get-ConfigPort $config
  $pidProc = Get-ApiProcessFromPidFile
  $portPid = Get-ListeningProcessId $port

  Write-Host "Config: $ConfigPath"
  Write-Host "Port: $port"
  if ($null -ne $pidProc) {
    Write-Host "PID file process: running, pid=$($pidProc.ProcessId)"
    Write-Host "Command: $($pidProc.CommandLine)"
  } else {
    Write-Host "PID file process: not running"
  }
  if ($null -ne $portPid) {
    Write-Host "Port listener: pid=$portPid"
  } else {
    Write-Host "Port listener: none"
  }
  $health = Get-HealthPayload $port
  if ($null -ne $health) {
    Write-Host "Health: status=$($health.status), model=$($health.model), server=$($health.server)"
  } else {
    Write-Host "Health: unavailable"
  }
}

function Start-ApiService {
  $config = Read-ApiConfig
  $port = Get-ConfigPort $config
  $existingPid = Get-ListeningProcessId $port
  if ($null -ne $existingPid) {
    $existingProc = Get-ProcessById $existingPid
    if (-not (Test-IsApiProcess $existingProc)) {
      throw "Port $port is already occupied by a non-Tailect process, pid=$existingPid."
    }
    $health = Get-HealthPayload $port
    if ($null -eq $health -or [string]$health.status -ne "ok") {
      throw "Tailect API process is listening on port $port but /health is not ready, pid=$existingPid."
    }
    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    Set-Content -LiteralPath $PidFile -Value ([string]$existingPid) -Encoding ASCII
    Write-Host "Tailect ASR v1 API is already running, pid=$existingPid."
    Write-Host "Health: status=$($health.status), model=$($health.model), server=$($health.server)"
    return
  }
  if (-not (Test-Path -LiteralPath $PythonExe)) {
    throw "python.exe not found: $PythonExe"
  }
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

  $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
  $stdout = Join-Path $LogDir "api_v1_service_stdout_$timestamp.log"
  $stderr = Join-Path $LogDir "api_v1_service_stderr_$timestamp.log"
  $args = @("-m", "tailect_asr.cli.api_v1", "--config", $ConfigPath)
  $proc = Start-Process -FilePath $PythonExe -ArgumentList $args -WorkingDirectory $RootDir -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath $PidFile -Value ([string]$proc.Id) -Encoding ASCII
  Write-Host "Starting Tailect ASR v1 API, pid=$($proc.Id)"
  Write-Host "Config: $ConfigPath"
  Write-Host "Health: http://127.0.0.1:$port/health"
  Write-Host "Stdout: $stdout"
  Write-Host "Stderr: $stderr"
  $health = Wait-ApiReady -ProcessId $proc.Id -Port $port
  if ($null -eq $health) {
    $running = Get-ProcessById $proc.Id
    if ($null -ne $running) {
      Stop-Process -Id $proc.Id -ErrorAction SilentlyContinue
    }
    Set-Content -LiteralPath $PidFile -Value "" -Encoding ASCII
    throw "Tailect ASR v1 API did not become ready within 180 seconds. Check stderr: $stderr"
  }
  Write-Host "Started Tailect ASR v1 API, pid=$($proc.Id)"
  Write-Host "Ready: status=$($health.status), model=$($health.model), server=$($health.server)"
}

function Stop-ApiService {
  $proc = Get-ApiProcessFromPidFile
  if ($null -eq $proc) {
    if (Test-Path -LiteralPath $PidFile) {
      Set-Content -LiteralPath $PidFile -Value "" -Encoding ASCII
    }
    Write-Host "No running API service process found from PID file."
    return
  }
  Stop-Process -Id ([int]$proc.ProcessId) -ErrorAction Stop
  Wait-Process -Id ([int]$proc.ProcessId) -Timeout 30 -ErrorAction SilentlyContinue
  Set-Content -LiteralPath $PidFile -Value "" -Encoding ASCII
  Set-Content -LiteralPath $StopFile -Value ("stopped pid={0} at {1}" -f $proc.ProcessId, (Get-Date -Format "yyyy-MM-dd HH:mm:ss")) -Encoding UTF8
  Write-Host "Stopped Tailect ASR v1 API, pid=$($proc.ProcessId)"
}

switch ($Action) {
  "start" { Start-ApiService }
  "stop" { Stop-ApiService }
  "status" { Show-Status }
}
