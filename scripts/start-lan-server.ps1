[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 4173,

  [string]$AllowedSubnet,

  [switch]$SkipBuild,

  [switch]$NoFirewall
)

$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$firewallRuleName = "FABVIEW LAN $Port"
$logDirectory = Join-Path $projectRoot 'temp'
$stdoutLog = Join-Path $logDirectory 'fabview-lan.stdout.log'
$stderrLog = Join-Path $logDirectory 'fabview-lan.stderr.log'

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-NetworkAddress {
  param(
    [Parameter(Mandatory)]
    [string]$IPAddress,

    [Parameter(Mandatory)]
    [ValidateRange(1, 32)]
    [int]$PrefixLength
  )

  $remainingBits = $PrefixLength
  $networkParts = foreach ($part in $IPAddress.Split('.')) {
    $mask = if ($remainingBits -ge 8) {
      255
    } elseif ($remainingBits -le 0) {
      0
    } else {
      [int](256 - [Math]::Pow(2, 8 - $remainingBits))
    }
    $remainingBits -= 8
    ([int]$part -band $mask)
  }
  return "$($networkParts -join '.')/$PrefixLength"
}

function Normalize-AllowedSubnet {
  param([Parameter(Mandatory)][string]$Subnet)

  $parts = $Subnet.Split('/')
  if ($parts.Count -ne 2) { throw 'AllowedSubnet must use IPv4 CIDR notation, for example 192.168.123.0/24.' }
  $address = [System.Net.IPAddress]::None
  if (-not [System.Net.IPAddress]::TryParse($parts[0], [ref]$address) -or
      $address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw 'AllowedSubnet must contain an IPv4 address.'
  }
  $prefix = 0
  if (-not [int]::TryParse($parts[1], [ref]$prefix) -or $prefix -lt 1 -or $prefix -gt 32) {
    throw 'AllowedSubnet must contain a prefix between 1 and 32.'
  }
  return "$($address.IPAddressToString)/$prefix"
}

function Get-ActiveLanAddress {
  $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop |
    Sort-Object RouteMetric, InterfaceMetric |
    Select-Object -First 1
  if (-not $route) { throw 'No default IPv4 route was found.' }

  $address = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*' -and
      -not $_.SkipAsSource
    } |
    Select-Object -First 1
  if (-not $address) { throw 'No IPv4 address was found for the default network adapter.' }

  return [pscustomobject]@{
    IPAddress = $address.IPAddress
    PrefixLength = $address.PrefixLength
    InterfaceIndex = $route.InterfaceIndex
  }
}

function Stop-ExistingFabViewServer {
  param([int]$ListenPort)

  $listener = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $listener) { return }

  $listenerProcessId = $listener.OwningProcess
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerProcessId"
  if (-not $processInfo.CommandLine -or $processInfo.CommandLine -notmatch 'kingdee_server\.py') {
    throw "Port $ListenPort is in use by $($processInfo.Name); the non-FABVIEW process was not stopped."
  }

  Stop-Process -Id $listenerProcessId -Force
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 150
    $stillListening = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $stillListening) { return }
  }
  throw "The previous FABVIEW process did not release port $ListenPort."
}

function Set-FabViewFirewallRule {
  param(
    [Parameter(Mandatory)]
    [string]$RemoteSubnet,

    [Parameter(Mandatory)]
    [int]$ListenPort
  )

  if (Test-IsAdministrator) {
    Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue |
      Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule `
      -DisplayName $firewallRuleName `
      -Description 'FABVIEW Gerber 3D LAN access' `
      -Direction Inbound `
      -Action Allow `
      -Protocol TCP `
      -LocalPort $ListenPort `
      -RemoteAddress $RemoteSubnet `
      -Profile Any | Out-Null
    return
  }

  # Only the firewall operation needs elevation. Keeping the app process outside the
  # elevated shell prevents Start-Process -Wait from tracking the long-running server.
  $commandFile = Join-Path ([System.IO.Path]::GetTempPath()) ("fabview-firewall-$([guid]::NewGuid().ToString('N')).cmd")
  @(
    '@echo off',
    "netsh advfirewall firewall delete rule name=`"$firewallRuleName`" >nul 2>&1",
    "netsh advfirewall firewall add rule name=`"$firewallRuleName`" dir=in action=allow protocol=TCP localport=$ListenPort remoteip=$RemoteSubnet profile=any"
  ) | Set-Content -LiteralPath $commandFile -Encoding ascii
  try {
    $elevated = Start-Process -FilePath 'cmd.exe' -Verb RunAs -ArgumentList "/d /c `"$commandFile`"" -Wait -PassThru
    if ($elevated.ExitCode -ne 0) { throw "Unable to update firewall rule $firewallRuleName." }
  } finally {
    Remove-Item -LiteralPath $commandFile -Force -ErrorAction SilentlyContinue
  }
}

$lan = Get-ActiveLanAddress
if (-not $AllowedSubnet) {
  $AllowedSubnet = Get-NetworkAddress -IPAddress $lan.IPAddress -PrefixLength $lan.PrefixLength
}
$AllowedSubnet = Normalize-AllowedSubnet -Subnet $AllowedSubnet

if (-not $SkipBuild) {
  Write-Host 'Building FABVIEW production files...'
  Push-Location $projectRoot
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html') -PathType Leaf)) {
  throw 'dist/index.html was not found. Run npm run build first.'
}

if (-not $NoFirewall) {
  Set-FabViewFirewallRule -RemoteSubnet $AllowedSubnet -ListenPort $Port
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
Stop-ExistingFabViewServer -ListenPort $Port

$python = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python -ErrorAction SilentlyContinue }
if (-not $python) { throw 'Python was not found. Install Python 3.10 or later.' }

$serverProcess = Start-Process `
  -FilePath $python.Source `
  -ArgumentList @('server/kingdee_server.py', '--host', '0.0.0.0', '--port', "$Port") `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

$listener = $null
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($listener) { break }
  Start-Sleep -Milliseconds 250
}
if (-not $listener) {
  $errors = if (Test-Path -LiteralPath $stderrLog) { Get-Content -LiteralPath $stderrLog -Raw } else { '' }
  throw "FABVIEW did not start listening on port $Port. $errors"
}

$url = "http://$($lan.IPAddress):$Port/"
Write-Host ''
Write-Host 'FABVIEW LAN deployment is running.' -ForegroundColor Green
Write-Host "URL: $url"
Write-Host "Allowed subnet: $AllowedSubnet"
Write-Host "Server process: $($serverProcess.Id)"
Write-Host "Logs: $stdoutLog"
