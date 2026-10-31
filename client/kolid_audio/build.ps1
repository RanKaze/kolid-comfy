# Build KolidAudio.dll  (ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM)
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1
# Output: KolidAudio.dll next to this file (the backend locates it relative to __file__)
#
# Same constraints as client/kolid_clock/build.ps1: INCLUDE/LIB are set by hand and the
# import libraries are minted from .def files, because vcvars64.bat shells out to reg.exe
# which policy blocks here.
#
# Note: a Windows SDK *does* exist on this machine (F:\Windows Kits\10\10.0.26100.0), and
# it is left deliberately unused. Using it would add windows.h/ole32 to the build for no
# gain - the audio paths (waveOut, and the hand-declared VST3 ABI in ka_vst3.h) only need
# the handful of kernel32/winmm exports listed in the .def files. Keeping the build free of
# SDK headers means it keeps working when the SDK path or version changes.
#
# winmm is the reason this build even works: WASAPI would need mmdeviceapi.h / ole32.lib, neither
# of which exists on this machine, while waveOut is a plain C API with seven exports.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$cl = Get-ChildItem -Path 'C:\Program Files (x86)\Microsoft Visual Studio','C:\Program Files\Microsoft Visual Studio' `
    -Filter cl.exe -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*Hostx64\x64*' } | Select-Object -First 1
if (-not $cl) { throw 'cl.exe not found - no MSVC toolchain on this machine.' }

$binDir  = $cl.DirectoryName
$msvc    = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $binDir))
$libDir  = Join-Path $msvc 'lib\x64'
$incDir  = Join-Path $msvc 'include'

$env:PATH = $binDir + ';' + $env:PATH
$env:INCLUDE = $incDir
$env:LIB = $libDir

Push-Location $here
try {
    $build = Join-Path $here 'build'
    if (-not (Test-Path $build)) { New-Item -ItemType Directory -Path $build | Out-Null }

    & (Join-Path $binDir 'lib.exe') /nologo /def:kernel32.def /machine:x64 /out:"$build\kernel32.lib"
    if ($LASTEXITCODE -ne 0) { throw "lib kernel32 exited with $LASTEXITCODE" }

    & (Join-Path $binDir 'lib.exe') /nologo /def:winmm.def /machine:x64 /out:"$build\winmm.lib"
    if ($LASTEXITCODE -ne 0) { throw "lib winmm exited with $LASTEXITCODE" }

    & $cl.FullName /nologo /utf-8 /O2 /W3 /GS- /TC kolid_audio.c /link `
        /NODEFAULTLIB /ENTRY:DllMain /DLL /LIBPATH:"$build" kernel32.lib winmm.lib /OUT:KolidAudio.dll
    if ($LASTEXITCODE -ne 0) { throw "cl exited with $LASTEXITCODE" }

    Write-Host ''
    Write-Host ('OK -> ' + (Join-Path $here 'KolidAudio.dll'))
} finally {
    Pop-Location
}
