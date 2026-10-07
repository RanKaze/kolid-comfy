# 为 .cud 注册资源管理器缩略图提供器(当前用户级,HKCU,不需要管理员)
# 键布局与 regasm /codebase 的输出一致(InprocServer32\<版本> 子键是 mscoree
# 真正读取的地方,缺了它激活报 0x80040154)。
#
# shellex 键名 = IThumbnailProvider 的接口 IID {E357FCCD-A995-4576-B01F-234630154E96}
# (与 MS 文档里"缩略图处理器 Shell extension 的 GUID"是同一个值;C# 类里接口声明的
# GUID 必须是它,否则 Win11 抽取宿主 QueryInterface 拿不到接口 → 静默回退通用图标)。
# 切勿给本 CLSID 写 DisableProcessIsolation —— Win11 的隔离宿主会因此拒绝加载。
$ErrorActionPreference = 'Stop'
$clsid = '{D4A7C2F1-6B3E-4E5A-9C48-12F7A0B5D8E3}'
$thumbGuid = '{E357FCCD-A995-4576-B01F-234630154E96}'
$legacyGuid = '{e357fccd-a995-45da-9450-b2c9ded750c0}'   # 早期误用值,写它等于没注册
$version = '1.0.0.0'
$dll = Join-Path $PSScriptRoot 'CudThumbnail.dll'
if (-not (Test-Path $dll)) { throw "CudThumbnail.dll not found — run install.bat first" }
$codebase = (New-Object System.Uri($dll)).AbsoluteUri

$mscoree = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\mscoree.dll'
if (-not (Test-Path $mscoree)) {
    $mscoree = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\mscoree.dll'
}
if (-not (Test-Path $mscoree)) {
    # 新版 Win11:加载 shim 是系统组件,住在 System32
    $mscoree = Join-Path $env:WINDIR 'System32\mscoree.dll'
}
if (-not (Test-Path $mscoree)) { throw '.NET Framework mscoree.dll not found' }

$clsidKey = "HKCU:\Software\Classes\CLSID\$clsid"
New-Item -Path $clsidKey -Force | Out-Null
Set-Item -Path $clsidKey -Value 'CudThumbnail.CudThumbnailProvider'
# 防呆:清掉实验遗留的隔离开关(它会堵死 Win11 缩略图抽取)
Remove-ItemProperty -Path $clsidKey -Name 'DisableProcessIsolation' -ErrorAction SilentlyContinue

$inproc = "$clsidKey\InprocServer32"
New-Item -Path $inproc -Force | Out-Null
Set-Item -Path $inproc -Value $mscoree
Set-ItemProperty -Path $inproc -Name 'ThreadingModel' -Value 'Both'
Set-ItemProperty -Path $inproc -Name 'Class' -Value 'CudThumbnail.CudThumbnailProvider'
Set-ItemProperty -Path $inproc -Name 'Assembly' -Value "CudThumbnail, Version=$version, Culture=neutral, PublicKeyToken=null"
Set-ItemProperty -Path $inproc -Name 'RuntimeVersion' -Value 'v4.0.30319'
Set-ItemProperty -Path $inproc -Name 'CodeBase' -Value $codebase

$verKey = "$inproc\$version"
New-Item -Path $verKey -Force | Out-Null
Set-ItemProperty -Path $verKey -Name 'Class' -Value 'CudThumbnail.CudThumbnailProvider'
Set-ItemProperty -Path $verKey -Name 'Assembly' -Value "CudThumbnail, Version=$version, Culture=neutral, PublicKeyToken=null"
Set-ItemProperty -Path $verKey -Name 'RuntimeVersion' -Value 'v4.0.30319'
Set-ItemProperty -Path $verKey -Name 'CodeBase' -Value $codebase

New-Item -Path "$clsidKey\ProgId" -Force | Out-Null
Set-Item -Path "$clsidKey\ProgId" -Value 'CudThumbnail.Provider'
# .NET 自动化类别标记(mscoree 靠它认出这是托管类)
New-Item -Path "$clsidKey\Implemented Categories\{62C8FE65-4EBB-45E7-B440-6E39B2CDBF29}" -Force | Out-Null

# ProgId 根键
New-Item -Path 'HKCU:\Software\Classes\CudThumbnail.Provider\CLSID' -Force | Out-Null
Set-Item -Path 'HKCU:\Software\Classes\CudThumbnail.Provider' -Value 'CudThumbnail.CudThumbnailProvider'
Set-Item -Path 'HKCU:\Software\Classes\CudThumbnail.Provider\CLSID' -Value $clsid

# .cud:ProgID 关联 + 两处 shellex(ProgID 级与扩展名级都写,双保险)
New-Item -Path 'HKCU:\Software\Classes\.cud' -Force | Out-Null
Set-Item -Path 'HKCU:\Software\Classes\.cud' -Value 'cud.document'
New-Item -Path 'HKCU:\Software\Classes\cud.document' -Force | Out-Null
Set-Item -Path 'HKCU:\Software\Classes\cud.document' -Value 'Kolid Blend Document'
$repoIcon = Join-Path $PSScriptRoot '..\icon.ico'
if (Test-Path $repoIcon) {
    New-Item -Path 'HKCU:\Software\Classes\cud.document\DefaultIcon' -Force | Out-Null
    Set-Item -Path 'HKCU:\Software\Classes\cud.document\DefaultIcon' -Value (Resolve-Path $repoIcon).Path
}
New-Item -Path "HKCU:\Software\Classes\cud.document\shellex\$thumbGuid" -Force | Out-Null
Set-Item -Path "HKCU:\Software\Classes\cud.document\shellex\$thumbGuid" -Value $clsid
New-Item -Path "HKCU:\Software\Classes\.cud\shellex\$thumbGuid" -Force | Out-Null
Set-Item -Path "HKCU:\Software\Classes\.cud\shellex\$thumbGuid" -Value $clsid

# 清掉历史误注册(45da 变体)
Remove-Item -Path "HKCU:\Software\Classes\cud.document\shellex\$legacyGuid" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "HKCU:\Software\Classes\.cud\shellex\$legacyGuid" -Recurse -Force -ErrorAction SilentlyContinue

# 双击 .cud → Kolid Desktop(Blend 窗口自任页面与文档接口,不依赖 ComfyUI)。
# exe 在仓库根,缺失只跳过双击关联 —— 缩略图注册与它无关。
$exe = Join-Path (Join-Path $PSScriptRoot '..\..') 'Kolid Desktop.exe'
if (Test-Path $exe) {
    $cmd = '"{0}" "%1"' -f (Resolve-Path $exe).Path
    New-Item -Path 'HKCU:\Software\Classes\cud.document\shell\open\command' -Force | Out-Null
    Set-Item -Path 'HKCU:\Software\Classes\cud.document\shell\open\command' -Value $cmd
    Write-Host "Double-click opens with: $cmd"
} else {
    Write-Host 'Kolid Desktop.exe not at the repo root — double-click association skipped.'
}

# 通知外壳"关联已变更",免重启 explorer 生效
Add-Type -Namespace CudThumb -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);'
[CudThumb.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Host "Registered .cud thumbnail provider (per-user)."
Write-Host "If icons do not refresh immediately, restart explorer.exe or sign out/in."
