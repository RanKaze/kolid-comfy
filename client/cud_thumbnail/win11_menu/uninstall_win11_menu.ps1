# uninstall_win11_menu.ps1 - remove the Win11 first-level menu package (elevated,
# one UAC prompt) and clean the packed msix. Called by
# uninstall_windows_integration.bat. Idempotent.
# The .\tools\ makeappx cache and the built DLL/stub are left in place so a
# re-install stays offline and instant; delete .\tools\ manually to reclaim ~5MB.
# exit codes: 0 removed / 1 failed / 3 not installed / 4 UAC declined
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$here  = $PSScriptRoot
$build = Join-Path $here 'build'

$pkgs = @(Get-AppxPackage -Name 'Kolid.CudContextMenu' -ErrorAction SilentlyContinue)
if ($pkgs.Count -eq 0) {
    if (Test-Path $build) { Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host '[i] Win11 first-level menu: not installed.'
    exit 3
}

Write-Host 'Removing the package - a UAC prompt will appear, please accept it ...'
$child  = Join-Path $here 'appx_child.ps1'
$result = Join-Path $env:TEMP 'kolid_appx_result.txt'
if (Test-Path $result) { Remove-Item $result -Force }
try {
    $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList @(
        '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$child`"",
        '-Action', 'remove', '-Result', "`"$result`"")
} catch {
    Write-Host "[!] elevation declined or failed: $($_.Exception.Message)"
    exit 4
}
$out = 'no result file'
if (Test-Path $result) { $out = (Get-Content $result -Raw).Trim() }
if ($p.ExitCode -eq 0) {
    if (Test-Path $build) { Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host "[OK] Win11 first-level menu removed. $out"
    exit 0
}
Write-Host "[X] Remove-AppxPackage failed (child exit $($p.ExitCode)): $out"
exit 1
