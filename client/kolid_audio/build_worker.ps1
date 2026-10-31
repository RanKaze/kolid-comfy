# Build KaPluginWorker.exe  (ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM)
# Usage:  powershell -ExecutionPolicy Bypass -File build_worker.ps1
# Output: KaPluginWorker.exe next to this file
#
# Same constraints as build.ps1: no CRT, no SDK, INCLUDE/LIB set by hand, import libraries
# minted from kernel32.def. This is a *console exe* so it needs its own entry point (kaMain)
# and ExitProcess - there is no CRT to return to.
#
# Why a separate process at all: one real plugin on this machine crashes the whole process on
# load. Loading it inside ComfyUI takes down every open project with it. In here, the only
# thing that dies is this exe, and the host sees it as a stalled heartbeat.

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

    & $cl.FullName /nologo /utf-8 /O2 /W3 /GS- /TC ka_worker.c /link `
        /NODEFAULTLIB /ENTRY:kaMain /SUBSYSTEM:CONSOLE /LIBPATH:"$build" kernel32.lib /OUT:KaPluginWorker.exe
    if ($LASTEXITCODE -ne 0) { throw "cl exited with $LASTEXITCODE" }

    Write-Host ''
    Write-Host ('OK -> ' + (Join-Path $here 'KaPluginWorker.exe'))
} finally {
    Pop-Location
}
