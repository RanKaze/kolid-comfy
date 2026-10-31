# Build KaTestSynth.vst3 (a minimal VST3 plugin used as the host's ruler).
# ASCII only: PowerShell 5.1 reads .ps1 as ANSI when there is no BOM.
#
# Same constraints as ../build.ps1: MSVC present, no SDK headers needed, no CRT
# (/NODEFAULTLIB). The plugin does not call any kernel32 function, so it needs no
# import library at all - which is exactly why it is a clean test of the host.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out  = Join-Path $here 'KaTestSynth.vst3'

$cl = Get-ChildItem -Path 'C:\Program Files (x86)\Microsoft Visual Studio','C:\Program Files\Microsoft Visual Studio' `
    -Filter cl.exe -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*Hostx64\x64*' } | Select-Object -First 1
if (-not $cl) { throw 'cl.exe not found - no MSVC toolchain on this machine.' }

$binDir = $cl.DirectoryName
$msvc   = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $binDir))
$env:PATH = $binDir + ';' + $env:PATH
$env:INCLUDE = Join-Path $msvc 'include'
$env:LIB = Join-Path $msvc 'lib\x64'

Push-Location $here
try {
    & $cl.FullName /nologo /utf-8 /O2 /W3 /GS- /TC ka_testplug.c /link `
        /NODEFAULTLIB /ENTRY:DllMain /DLL /OUT:"$out"
    if ($LASTEXITCODE -ne 0) { throw "cl exited with $LASTEXITCODE" }
    Write-Host ''
    Write-Host ('OK -> ' + $out)
} finally {
    Pop-Location
}
