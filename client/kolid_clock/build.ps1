# Build KolidClock.dll  (ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM)
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1
# Output: KolidClock.dll next to this file (the backend locates it relative to __file__)
#
# Why this script sets INCLUDE/LIB by hand instead of calling vcvars64.bat:
#   this machine has the MSVC compiler but no Windows SDK, and vcvars64 also shells out to reg.exe
#   which is blocked by policy here. So we point cl at the compiler's own include/lib, and mint a
#   kernel32 import library from kernel32.def (only two symbols are needed).

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$cl = Get-ChildItem -Path 'C:\Program Files (x86)\Microsoft Visual Studio','C:\Program Files\Microsoft Visual Studio' `
    -Filter cl.exe -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*Hostx64\x64*' } | Select-Object -First 1
if (-not $cl) { throw 'cl.exe not found - no MSVC toolchain on this machine.' }

$binDir  = $cl.DirectoryName                                   # ...\VC\Tools\MSVC\<ver>\bin\Hostx64\x64
$msvc    = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $binDir))   # ...\VC\Tools\MSVC\<ver>
$libDir  = Join-Path $msvc 'lib\x64'
$incDir  = Join-Path $msvc 'include'

$env:PATH = $binDir + ';' + $env:PATH
$env:INCLUDE = $incDir
$env:LIB = $libDir

Push-Location $here
try {
    $build = Join-Path $here 'build'
    if (-not (Test-Path $build)) { New-Item -ItemType Directory -Path $build | Out-Null }

    # 1) kernel32 import library (two exports, nothing else).
    & (Join-Path $binDir 'lib.exe') /nologo /def:kernel32.def /machine:x64 /out:"$build\kernel32.lib"
    if ($LASTEXITCODE -ne 0) { throw "lib exited with $LASTEXITCODE" }

    # 2) the DLL. /LD = dynamic library, /O2 = optimize, /GS- = no stack cookie.
    #    /NODEFAULTLIB + /ENTRY:DllMain: there is no UCRT on this machine (no Windows SDK), and this
    #    translation unit calls nothing from it — so link with no C runtime at all and enter straight
    #    at DllMain.
    & $cl.FullName /nologo /utf-8 /O2 /W3 /LD /GS- /TC kolid_clock.c /link `
        /NODEFAULTLIB /ENTRY:DllMain /LIBPATH:"$build" kernel32.lib /OUT:KolidClock.dll
    if ($LASTEXITCODE -ne 0) { throw "cl exited with $LASTEXITCODE" }

    Write-Host ''
    Write-Host ('OK -> ' + (Join-Path $here 'KolidClock.dll'))
} finally {
    Pop-Location
}
