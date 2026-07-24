param(
  [Parameter(Mandatory = $true)][ValidateSet('x64', 'arm64')][string]$Arch,
  [Parameter(Mandatory = $true)][ValidateSet('stable', 'beta')][string]$ReleaseChannel,
  [Parameter(Mandatory = $true)][string]$ExpectedMachine,
  [string]$ReleaseDirectory = 'release',
  [switch]$LegacyBridge
)

$ErrorActionPreference = 'Stop'

function Test-PeMachine([string]$Path, [UInt16]$Expected) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $reader = [System.IO.BinaryReader]::new($stream)
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    $stream.Position = $peOffset + 4
    $machine = $reader.ReadUInt16()
  } finally {
    $stream.Dispose()
  }
  if ($machine -ne $Expected) {
    throw ('Packaged PE machine 0x{0:X4} does not match expected 0x{1:X4}' -f $machine, $Expected)
  }
}

function New-ExactEnvironment([string]$Profile, [string]$TemporaryDirectory) {
  return @{
    APPDATA = (Join-Path $Profile 'AppData/Roaming')
    COMSPEC = $env:COMSPEC
    LOCALAPPDATA = (Join-Path $Profile 'AppData/Local')
    MESSENGER_TEST_SKIP_STARTUP_PERMISSIONS = 'true'
    PATH = "$env:SystemRoot\System32;$env:SystemRoot"
    ProgramData = $env:ProgramData
    ProgramFiles = $env:ProgramFiles
    'ProgramFiles(x86)' = ${env:ProgramFiles(x86)}
    SKIP_SINGLE_INSTANCE_LOCK = 'true'
    SystemDrive = $env:SystemDrive
    SystemRoot = $env:SystemRoot
    TEMP = $TemporaryDirectory
    TMP = $TemporaryDirectory
    USERPROFILE = $Profile
    WINDIR = $env:WINDIR
  }
}

function Start-ExactProcess(
  [string]$Executable,
  [string[]]$Arguments,
  [hashtable]$Environment,
  [bool]$Wait
) {
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new($Executable)
  $startInfo.UseShellExecute = $false
  foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add($argument) }
  $startInfo.Environment.Clear()
  foreach ($entry in $Environment.GetEnumerator()) {
    if ($null -ne $entry.Value) { $startInfo.Environment[$entry.Key] = [string]$entry.Value }
  }
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if ($Wait) {
    if (-not $process.WaitForExit(120000)) {
      taskkill /PID $process.Id /T /F | Out-Null
      throw "$Executable timed out"
    }
    if ($process.ExitCode -ne 0) { throw "$Executable exited with code $($process.ExitCode)" }
  }
  return $process
}

$expected = [Convert]::ToUInt16($ExpectedMachine.Substring(2), 16)
$products = if ($LegacyBridge) {
  if ($ReleaseChannel -eq 'stable') {
    @(@{ Prefix = 'Messenger'; DataName = 'Messenger'; Executable = 'Messenger.exe' })
  } else {
    @(@{ Prefix = 'Messenger-Beta'; DataName = 'Messenger-Beta'; Executable = 'Messenger Beta.exe' })
  }
} elseif ($ReleaseChannel -eq 'stable') {
  @(
    @{ Prefix = 'Messenger'; DataName = 'Messenger'; Executable = 'Messenger.exe' },
    @{ Prefix = 'Messenger-Beta'; DataName = 'Messenger-Beta'; Executable = 'Messenger Beta.exe' }
  )
} else {
  @(@{ Prefix = 'Messenger-Beta'; DataName = 'Messenger-Beta'; Executable = 'Messenger Beta.exe' })
}

foreach ($product in $products) {
  $installerName = if ($LegacyBridge) {
    "$($product.Prefix)-windows-setup.exe"
  } else {
    "$($product.Prefix)-windows-$Arch-setup.exe"
  }
  $installer = Join-Path $ReleaseDirectory $installerName
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Missing installer $installer" }
  $smokeRoot = Join-Path $env:RUNNER_TEMP "messenger-nsis-$($product.DataName)-$Arch"
  $profile = Join-Path $smokeRoot 'profile'
  $temporaryDirectory = Join-Path $smokeRoot 'tmp'
  New-Item -ItemType Directory -Force -Path $profile, $temporaryDirectory | Out-Null
  $environment = New-ExactEnvironment $profile $temporaryDirectory

  [void](Start-ExactProcess (Resolve-Path $installer) @('/S') $environment $true)
  $programs = Join-Path $environment.LOCALAPPDATA 'Programs'
  $application = Get-ChildItem $programs -Recurse -Filter $product.Executable |
    Select-Object -First 1
  if (-not $application) { throw "NSIS did not install an application executable for $($product.Prefix)" }
  Test-PeMachine $application.FullName $expected

  $userData = Join-Path $environment.APPDATA $product.DataName
  New-Item -ItemType Directory -Force -Path $userData | Out-Null
  Set-Content -LiteralPath (Join-Path $userData 'update-frequency.json') -Value '{"frequency":"never"}' -NoNewline
  $applicationProcess = Start-ExactProcess $application.FullName @() $environment $false
  Start-Sleep -Seconds 8
  if ($applicationProcess.HasExited) {
    throw "$($product.Prefix) installed runtime exited early with code $($applicationProcess.ExitCode)"
  }
  taskkill /PID $applicationProcess.Id /T /F | Out-Null

  $uninstaller = Get-ChildItem $programs -Recurse -Filter 'Uninstall*.exe' | Select-Object -First 1
  if (-not $uninstaller) { throw "NSIS uninstaller was not installed for $($product.Prefix)" }
  $installDirectory = $uninstaller.Directory.FullName
  [void](Start-ExactProcess $uninstaller.FullName @('/S') $environment $true)
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ((Test-Path -LiteralPath $installDirectory) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  if (Test-Path -LiteralPath $installDirectory) {
    throw "NSIS uninstall left install directory $installDirectory"
  }
  Write-Host "Verified NSIS install, native runtime launch, and uninstall: $($product.Prefix) $Arch"
}
