# appx_child.ps1 - the elevated half of the Win11 first-level menu setup:
# Add-AppxPackage / Remove-AppxPackage, then a one-line result for the parent
# process. Spawned via Start-Process -Verb RunAs (one UAC prompt) by
# install_win11_menu.ps1 / uninstall_win11_menu.ps1. Exit 0 = ok, 1 = failed.
param(
    [Parameter(Mandatory)][ValidateSet('add', 'remove')][string]$Action,
    [string]$Msix,
    [string]$PackageName = 'Kolid.CudContextMenu',
    [Parameter(Mandatory)][string]$Result
)
$ErrorActionPreference = 'Stop'
$ok = $false
$msg = ''
try {
    if ($Action -eq 'add') {
        # -AllowUnsigned needs the OID-publisher manifest the packer injects.
        Add-AppxPackage -Path $Msix -AllowUnsigned
        $ok = $true
        $msg = "Add-AppxPackage ok: $Msix"
    } else {
        $pkgs = @(Get-AppxPackage -AllUsers -Name $PackageName)
        if ($pkgs.Count -eq 0) {
            $ok = $true
            $msg = 'package not installed'
        } else {
            $pkgs | Remove-AppxPackage -AllUsers
            $ok = $true
            $msg = "removed $($pkgs.Count) package registration(s)"
        }
    }
} catch {
    $msg = $_.Exception.Message
}
$tag = 'FAIL'
if ($ok) { $tag = 'OK' }
('{0}: {1}' -f $tag, $msg) | Set-Content -Path $Result -Encoding UTF8
if ($ok) { exit 0 }
exit 1
