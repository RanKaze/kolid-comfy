# install_win11_menu.ps1 - build, pack and (elevated) install the Win11 modern
# (first-level) context menu for KolidUI > PNG. Called by
# install_windows_integration.bat; safe to run standalone.
#
# 1. g++ (MSYS2 ucrt64) rebuilds KolidCtxMenu.dll + KolidCtxMenuStub.exe from
#    ..\*.cpp, all -static: a libwinpthread-1.dll import makes the packaged
#    surrogate host fail to load the DLL (COM activation 0x8007007E, the menu
#    entry never appears). No g++ -> skip this feature only (exit 3); the
#    thumbnails / double-click / classic menu are unaffected.
# 2. makeappx toolset cached in .\tools\ (downloaded once from nuget:
#    Microsoft.Windows.SDK.BuildTools). makeappx.exe alone does NOT run - its
#    embedded manifest depends on sibling SxS assemblies (appxpackaging.dll,
#    opcservices.dll, two .manifest files); all five are cached together.
# 3. stage + patch AppxManifest.xml (OID publisher for -AllowUnsigned + fresh
#    <yy-2000>.<MMdd>.<hhmm>.<ss> version so the elevated Add is an in-place
#    upgrade), then pack .\build\KolidCtxMenu.msix. Version fields must be plain
#    integers <= 65535 with no leading zeros (makeappx rejects "1.0.1008.021243").
# 4. elevated Add-AppxPackage -AllowUnsigned (one UAC prompt): unsigned
#    packages with executable content must be installed for all users as admin.
#
# exit codes: 0 installed / 1 failed / 3 skipped (no toolchain or network)
#             4 skipped (UAC declined)
[CmdletBinding()]
param([switch]$SkipInstall)

$ErrorActionPreference = 'Stop'

$here  = $PSScriptRoot                          # ...\client\cud_thumbnail\win11_menu
$thumb = Split-Path $here -Parent               # ...\client\cud_thumbnail
$build = Join-Path $here 'build'
$tools = Join-Path $here 'tools'
$stage = Join-Path $env:TEMP 'kolid_msix_stage'
$msix  = Join-Path $build 'KolidCtxMenu.msix'

$toolset = @(
    'makeappx.exe',
    'appxpackaging.dll',
    'opcservices.dll',
    'Microsoft.Windows.Build.Appx.AppxPackaging.dll.manifest',
    'Microsoft.Windows.Build.Appx.OpcServices.dll.manifest'
)

function Fail([string]$msg) { Write-Host "[X] $msg"; exit 1 }
function Skip([string]$msg) { Write-Host "[!] $msg"; exit 3 }

# ---- Windows 11 only (the manifest requires build 22000+)
if ([Environment]::OSVersion.Version.Build -lt 22000) {
    Skip 'Not Windows 11 - first-level menu skipped.'
}

# ---- 1. rebuild the native command DLL + stub
$gxx = @('C:\msys64\ucrt64\bin\g++.exe', 'C:\msys64\mingw64\bin\g++.exe') |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $gxx) {
    $cmd = Get-Command g++ -ErrorAction SilentlyContinue
    if ($cmd) { $gxx = $cmd.Source }
}
if (-not $gxx) {
    Skip 'MSYS2 g++ not found - first-level menu skipped (install MSYS2 to enable it).'
}
# ucrt64 g++ must find its own bin on PATH or cc1plus silently fails (no output, exit 1)
$env:PATH = (Split-Path $gxx -Parent) + ';' + $env:PATH

Write-Host 'Building KolidCtxMenu.dll ...'
& $gxx -shared -O2 -s -static -static-libgcc -static-libstdc++ -finput-charset=utf-8 -o (Join-Path $here 'KolidCtxMenu.dll') (Join-Path $thumb 'KolidCtxMenu.cpp') -lole32 -lshlwapi -lshell32 -luuid
if ($LASTEXITCODE -ne 0) { Fail "g++ failed for KolidCtxMenu.dll (exit $LASTEXITCODE)" }

Write-Host 'Building KolidCtxMenuStub.exe ...'
& $gxx -O2 -s -static -mwindows -o (Join-Path $here 'KolidCtxMenuStub.exe') (Join-Path $thumb 'KolidCtxMenuStub.cpp')
if ($LASTEXITCODE -ne 0) { Fail "g++ failed for KolidCtxMenuStub.exe (exit $LASTEXITCODE)" }

$cudPng = Join-Path $thumb 'CudPng.exe'
if (-not (Test-Path $cudPng)) {
    Fail 'CudPng.exe missing - run install_windows_integration.bat so it gets built first.'
}

# ---- 2. makeappx toolset (cached; about 23MB download on first run)
$missing = @($toolset | Where-Object { -not (Test-Path (Join-Path $tools $_)) })
if ($missing.Count -gt 0) {
    Write-Host 'Downloading Microsoft.Windows.SDK.BuildTools from nuget (about 23MB, once) ...'
    $url   = 'https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.buildtools/10.0.26100.9169/microsoft.windows.sdk.buildtools.10.0.26100.9169.nupkg'
    $nupkg = Join-Path $env:TEMP 'kolid_sdkbt.nupkg'
    $ext   = Join-Path $env:TEMP 'kolid_sdkbt_ext'
    try {
        $prev = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $nupkg -UseBasicParsing
        $ProgressPreference = $prev
    } catch {
        Skip "nuget download failed ($($_.Exception.Message)) - first-level menu skipped."
    }
    if (Test-Path $ext) { Remove-Item $ext -Recurse -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($nupkg, $ext)
    $srcExe = Get-ChildItem $ext -Recurse -Filter makeappx.exe |
        Where-Object { $_.FullName -like '*\x64\*' } | Select-Object -First 1
    if (-not $srcExe) { Fail 'makeappx.exe not found inside the nuget package.' }
    New-Item -ItemType Directory -Force -Path $tools | Out-Null
    foreach ($f in $toolset) {
        $from = Join-Path $srcExe.DirectoryName $f
        if (-not (Test-Path $from)) { Fail "toolset file missing in the nuget package: $f" }
        Copy-Item $from (Join-Path $tools $f) -Force
    }
    Remove-Item $nupkg -Force -ErrorAction SilentlyContinue
    Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "makeappx toolset cached: $tools"
} else {
    Write-Host "makeappx toolset: $tools (cached)"
}

# ---- 3. stage + patch manifest + pack
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'Assets') | Out-Null
New-Item -ItemType Directory -Force -Path $build | Out-Null
Copy-Item (Join-Path $here 'Assets\*.png') (Join-Path $stage 'Assets') -Force
Copy-Item (Join-Path $here 'KolidCtxMenu.dll') $stage -Force
Copy-Item (Join-Path $here 'KolidCtxMenuStub.exe') $stage -Force
Copy-Item $cudPng $stage -Force

# Menu icon: the shell loads whatever path GetIcon returns. The DLL resolves
# icon.ico next to itself first (package root here), then ..\..\ (loose repo
# layout). Package files under WindowsApps are readable by BUILTIN\Users, so a
# plain path into the package works for Explorer's icon cache.
$icon = Join-Path (Split-Path $thumb -Parent) 'icon.ico'
if (Test-Path $icon) {
    Copy-Item $icon $stage -Force
} else {
    Write-Host '[!] client\icon.ico missing - menu icon falls back to a generic glyph.'
}

# OID publisher is mandatory for -AllowUnsigned; the per-run version makes the
# elevated Add an in-place upgrade (a same-version Add fails with 0x80073CFB).
$now = Get-Date
$ver = '{0}.{1}.{2}.{3}' -f ($now.Year - 2000), ($now.Month * 100 + $now.Day), ($now.Hour * 100 + $now.Minute), $now.Second
$xml = [System.IO.File]::ReadAllText((Join-Path $here 'AppxManifest.xml'))
$xml = $xml.Replace('Publisher="CN=Kolid-Comfy"', 'Publisher="CN=Kolid-Comfy, OID.2.25.311729368913984317654407730594956997722=1"')
$xml = $xml.Replace('Version="1.0.0.0"', 'Version="' + $ver + '"')
[System.IO.File]::WriteAllText((Join-Path $stage 'AppxManifest.xml'), $xml, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Packing $msix (version $ver) ..."
& (Join-Path $tools 'makeappx.exe') pack /d $stage /p $msix /o
if ($LASTEXITCODE -ne 0) { Fail "makeappx pack failed (exit $LASTEXITCODE)" }
if (-not (Test-Path $msix)) { Fail 'makeappx exited 0 but no msix was produced.' }
Write-Host ('Packed: {0} ({1} bytes)' -f $msix, (Get-Item $msix).Length)

if ($SkipInstall) { Write-Host 'SkipInstall: package built, not installed.'; exit 0 }

# ---- 4. elevated install (one UAC prompt)
Write-Host 'Installing the package - a UAC prompt will appear, please accept it ...'
$child  = Join-Path $here 'appx_child.ps1'
$result = Join-Path $env:TEMP 'kolid_appx_result.txt'
if (Test-Path $result) { Remove-Item $result -Force }
try {
    $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList @(
        '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$child`"",
        '-Action', 'add', '-Msix', "`"$msix`"", '-Result', "`"$result`"")
} catch {
    Write-Host "[!] elevation declined or failed: $($_.Exception.Message)"
    exit 4
}
$out = 'no result file'
if (Test-Path $result) { $out = (Get-Content $result -Raw).Trim() }
if ($p.ExitCode -eq 0) {
    Write-Host "[OK] Win11 first-level menu installed. $out"
    exit 0
}
Write-Host "[X] Add-AppxPackage failed (child exit $($p.ExitCode)): $out"
exit 1
