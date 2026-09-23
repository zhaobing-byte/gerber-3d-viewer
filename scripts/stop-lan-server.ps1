[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 4173,

  [switch]$KeepFirewallRule
)

$ErrorActionPreference = 'Stop'
$firewallRuleName = "FABVIEW LAN $Port"

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Stop-FabViewServer {
  param([Parameter(Mandatory)][int]$ListenPort)

  $listener = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $listener) { return $false }

  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
  if (-not $processInfo.CommandLine -or $processInfo.CommandLine -notmatch 'kingdee_server\.py') {
    throw "Port $ListenPort is in use by $($processInfo.Name); the non-FABVIEW process was not stopped."
  }

  Stop-Process -Id $listener.OwningProcess -Force
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 150
    $stillListening = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $stillListening) { return $true }
  }
  throw "The FABVIEW process did not release port $ListenPort."
}

function Remove-FabViewFirewallRule {
  if (Test-IsAdministrator) {
    Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue |
      Remove-NetFirewallRule -ErrorAction SilentlyContinue
    return
  }

  # Only deleting the firewall rule needs elevation; the service remains a normal user process.
  $commandFile = Join-Path ([System.IO.Path]::GetTempPath()) ("fabview-firewall-remove-$([guid]::NewGuid().ToString('N')).cmd")
  @(
    '@echo off',
    "netsh advfirewall firewall delete rule name=`"$firewallRuleName`""
  ) | Set-Content -LiteralPath $commandFile -Encoding ascii
  try {
    $elevated = Start-Process -FilePath 'cmd.exe' -Verb RunAs -ArgumentList "/d /c `"$commandFile`"" -Wait -PassThru
    if ($elevated.ExitCode -ne 0) { throw "Unable to remove firewall rule $firewallRuleName." }
  } finally {
    Remove-Item -LiteralPath $commandFile -Force -ErrorAction SilentlyContinue
  }
}

$stopped = Stop-FabViewServer -ListenPort $Port
if (-not $KeepFirewallRule) {
  Remove-FabViewFirewallRule
}

Write-Host ''
if ($stopped) {
  Write-Host 'FABVIEW LAN deployment has stopped.' -ForegroundColor Yellow
} else {
  Write-Host "No FABVIEW server was listening on port $Port."
}
if ($KeepFirewallRule) {
  Write-Host "Firewall rule $firewallRuleName was kept."
} else {
  Write-Host "Firewall rule $firewallRuleName was removed."
}
