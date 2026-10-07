# 解除 .cud 的全部 Windows 集成,并清掉相关产物:
#   1) 当前用户(HKCU):缩略图 COM、两处 shellex、双击打开、右键 KolidUI 菜单;
#   2) 机器级遗留(HKLM):旧 register_hklm.ps1 写过才有 —— 检测到请求提权一并清;
#   3) Explorer 的 FileExts 里指向 cud.document 的打开方式残留;
#   4) 释放缩略图宿主对 DLL 的占用,删除 CudThumbnail.dll / CudPng.exe。
# 幂等:没装过也能安全运行。由仓库根的 uninstall_windows_integration.bat 调用;
# 带 -HklmOnly 时只清机器级(HKLM),供提权子进程复用。
param([switch]$HklmOnly)

$ErrorActionPreference = 'Continue'
$script:failed = $false

$clsid      = '{D4A7C2F1-6B3E-4E5A-9C48-12F7A0B5D8E3}'
$thumbGuid  = '{E357FCCD-A995-4576-B01F-234630154E96}'
$legacyGuid = '{e357fccd-a995-45da-9450-b2c9ded750c0}'   # 早期误用值,写它等于没注册

function Remove-RegPath([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $path) {
        Write-Host "[X] could not remove $path"
        $script:failed = $true
    } else {
        Write-Host "[.] removed $path"
    }
}

# .cud 扩展键:只摘本安装写的两处 shellex、等于 cud.document 的默认值;
# 别家软件往里加的东西(OpenWithProgids 等)不动,壳完全空了才端掉整个键。
function Clear-CudExtension([string]$extPath) {
    foreach ($g in @($thumbGuid, $legacyGuid)) { Remove-RegPath "$extPath\shellex\$g" }
    if (Test-Path -LiteralPath "$extPath\shellex") {
        $sh = Get-Item -LiteralPath "$extPath\shellex"
        if ($sh.SubKeyCount -eq 0 -and $sh.ValueCount -eq 0) { Remove-RegPath "$extPath\shellex" }
    }
    if (-not (Test-Path -LiteralPath $extPath)) { return }
    $k = Get-Item -LiteralPath $extPath
    if ($k.GetValue('') -eq 'cud.document') {
        # 默认值只能用 .NET 接口删:Remove-ItemProperty 找不到名为 '(default)' 的属性,
        # 而 provider 返回的键是只读的(DeleteValue 会 UnauthorizedAccess),得自己开可写句柄。
        $hive = if ($extPath.StartsWith('HKLM:')) { [Microsoft.Win32.Registry]::LocalMachine } else { [Microsoft.Win32.Registry]::CurrentUser }
        $rk = $hive.OpenSubKey($extPath.Substring(6), $true)
        if ($null -ne $rk) { $rk.DeleteValue('', $false); $rk.Close() }
        if ((Get-Item -LiteralPath $extPath).GetValue('') -eq 'cud.document') {
            Write-Host "[X] could not clear default value of $extPath"
            $script:failed = $true
        } else {
            Write-Host "[.] cleared default value of $extPath"
        }
    }
    $k = Get-Item -LiteralPath $extPath
    if ($k.SubKeyCount -eq 0 -and $k.ValueCount -eq 0) { Remove-RegPath $extPath }
}

if ($HklmOnly) {
    # ---- 提权实例:只清机器级遗留 ----
    Remove-RegPath "HKLM:\Software\Classes\CLSID\$clsid"
    Remove-RegPath 'HKLM:\Software\Classes\CudThumbnail.Provider'
    Remove-RegPath 'HKLM:\Software\Classes\cud.document'
    Clear-CudExtension 'HKLM:\Software\Classes\.cud'
    if ($script:failed) { Write-Host '[X] machine-level cleanup incomplete'; exit 1 }
    Write-Host '[.] machine-level (HKLM) leftovers removed'
    exit 0
}

# ---- 1) 当前用户级注册 ----
Remove-RegPath "HKCU:\Software\Classes\CLSID\$clsid"
Remove-RegPath 'HKCU:\Software\Classes\CudThumbnail.Provider'
# cud.document 整棵都是本安装建的(默认值/图标/双击打开/KolidUI 菜单/shellex),整个删
Remove-RegPath 'HKCU:\Software\Classes\cud.document'
Clear-CudExtension 'HKCU:\Software\Classes\.cud'

# ---- 2) Explorer 打开方式残留(不动用户的 OpenWithList 历史) ----
$fe = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.cud'
$uc = "$fe\UserChoice"
if ((Test-Path -LiteralPath $uc) -and ((Get-Item -LiteralPath $uc).GetValue('ProgId') -eq 'cud.document')) {
    Remove-RegPath $uc
}
$owp = "$fe\OpenWithProgids"
if (Test-Path -LiteralPath $owp) {
    $k = Get-Item -LiteralPath $owp
    if ($k.GetValueNames() -contains 'cud.document') {
        Remove-ItemProperty -LiteralPath $owp -Name 'cud.document' -ErrorAction SilentlyContinue
        Write-Host '[.] cleared .cud OpenWithProgids entry'
    }
    $k = Get-Item -LiteralPath $owp
    if ($k.SubKeyCount -eq 0 -and $k.ValueCount -eq 0) { Remove-RegPath $owp }
}

# ---- 3) 机器级遗留(HKLM):存在才请求提权清 ----
$hkTargets = @(
    "Software\Classes\CLSID\$clsid",
    'Software\Classes\CudThumbnail.Provider',
    'Software\Classes\cud.document',
    'Software\Classes\.cud'
)
$lm = [Microsoft.Win32.Registry]::LocalMachine
$leftovers = @($hkTargets | Where-Object { $null -ne $lm.OpenSubKey($_) })
if ($leftovers.Count -gt 0) {
    Write-Host "[.] machine-level (HKLM) leftovers found - requesting admin..."
    try {
        $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
            '-File', ('"{0}"' -f $PSCommandPath), '-HklmOnly'
        )
        if ($p.ExitCode -ne 0) { Write-Host "[X] elevated cleanup exited with $($p.ExitCode)"; $script:failed = $true }
    } catch {
        Write-Host '[X] admin elevation was declined - machine-level leftovers were NOT removed'
        $script:failed = $true
    }
}

# ---- 4) 释放缩略图宿主占用,删产物 ----
Get-CimInstance Win32_Process -Filter "Name='dllhost.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains('AB8902B4-09CA-4BB6-B78D-A8F59079A8D5') } |
    ForEach-Object {
        Write-Host "[.] stopping thumbnail host (pid=$($_.ProcessId)) to free CudThumbnail.dll"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
foreach ($f in @('CudThumbnail.dll', 'CudPng.exe')) {
    $p = Join-Path $PSScriptRoot $f
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $ok = $false
    for ($i = 0; $i -lt 5 -and -not $ok; $i++) {
        try { Remove-Item -LiteralPath $p -Force -ErrorAction Stop; $ok = $true } catch { Start-Sleep -Milliseconds 400 }
    }
    if ($ok) { Write-Host "[.] deleted $f" }
    else {
        $renamed = $false
        try { Rename-Item -LiteralPath $p -NewName ($f + '.stale') -ErrorAction Stop; $renamed = $true } catch { }
        if ($renamed) { Write-Host "[X] $f was locked; renamed to $f.stale - sign out/in, then delete it" }
        else { Write-Host "[X] could not delete $f" }
        $script:failed = $true
    }
}

# 通知外壳,免重启 explorer 生效
Add-Type -Namespace CudThumb -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);'
[CudThumb.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

if ($script:failed) {
    Write-Host 'Unregister finished with warnings (see [X] lines above).'
    exit 1
}
Write-Host 'Unregistered all .cud integration. If icons are stale, restart explorer.exe or sign out/in.'
exit 0
