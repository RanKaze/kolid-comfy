# 取消 .cud 缩略图提供器的注册(当前用户级)
$clsid = '{D4A7C2F1-6B3E-4E5A-9C48-12F7A0B5D8E3}'
$thumbGuid = '{E357FCCD-A995-4576-B01F-234630154E96}'
$legacyGuid = '{e357fccd-a995-45da-9450-b2c9ded750c0}'
Remove-Item -Path "HKCU:\Software\Classes\CLSID\$clsid" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Classes\CudThumbnail.Provider' -Recurse -Force -ErrorAction SilentlyContinue
foreach ($g in @($thumbGuid, $legacyGuid)) {
    Remove-Item -Path "HKCU:\Software\Classes\.cud\shellex\$g" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "HKCU:\Software\Classes\cud.document\shellex\$g" -Recurse -Force -ErrorAction SilentlyContinue
}
# 双击关联(register.ps1 写的 open\command)
Remove-Item -Path 'HKCU:\Software\Classes\cud.document\shell\open' -Recurse -Force -ErrorAction SilentlyContinue
Add-Type -Namespace CudThumb -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);'
[CudThumb.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Host 'Unregistered. Restart explorer.exe to refresh.'
