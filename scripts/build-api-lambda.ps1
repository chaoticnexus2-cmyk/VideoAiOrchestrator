<#
.SYNOPSIS
  Assembles the API Lambda deployment bundle.

.DESCRIPTION
  Installs the pinned dependencies from cdk/lambda/api/requirements.txt using
  manylinux wheels (so awscrt and ijson carry Linux .so files rather than the
  build machine's binaries), then copies the handler source alongside them.

  Output goes to cdk/lambda/api-build/, which the CDK stack references as a
  Lambda code asset. The directory is gitignored and safe to delete.

.PARAMETER SkipDeps
  Refresh only handler.py and leave the installed dependencies in place. Much
  faster when iterating on handler code.
#>
[CmdletBinding()]
param(
    [switch]$SkipDeps
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $repoRoot "cdk\lambda\api"
$buildDir = Join-Path $repoRoot "cdk\lambda\api-build"
$requirements = Join-Path $sourceDir "requirements.txt"

if (-not (Test-Path $requirements)) {
    throw "Requirements file not found: $requirements"
}

if (-not $SkipDeps) {
    Write-Host "Cleaning $buildDir" -ForegroundColor Cyan
    if (Test-Path $buildDir) {
        Remove-Item -Recurse -Force $buildDir
    }
    New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

    Write-Host "Installing dependencies for linux/x86_64 (python 3.12)..." -ForegroundColor Cyan
    $pipLog = Join-Path $env:TEMP "vaio-api-pip.log"
    python -m pip install `
        --target $buildDir `
        --requirement $requirements `
        --platform manylinux2014_x86_64 `
        --python-version 3.12 `
        --implementation cp `
        --only-binary=:all: `
        --no-compile `
        --upgrade *> $pipLog

    if ($LASTEXITCODE -ne 0) {
        Get-Content $pipLog -Tail 40
        throw "pip install failed (exit $LASTEXITCODE). Full log: $pipLog"
    }

    # __pycache__ from the build host is useless in Lambda and only adds size.
    Get-ChildItem -Path $buildDir -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

    # Console entry points are never executed inside Lambda.
    $binDir = Join-Path $buildDir "bin"
    if (Test-Path $binDir) {
        Remove-Item -Recurse -Force $binDir
    }

    $soCount = (Get-ChildItem -Path $buildDir -Recurse -Filter "*.so" -ErrorAction SilentlyContinue |
        Measure-Object).Count
    $pydCount = (Get-ChildItem -Path $buildDir -Recurse -Filter "*.pyd" -ErrorAction SilentlyContinue |
        Measure-Object).Count

    if ($pydCount -gt 0) {
        throw "Build contains $pydCount Windows .pyd extension(s); the manylinux platform flags did not take effect."
    }
    if ($soCount -eq 0) {
        throw "Build contains no Linux .so extensions; awscrt/ijson native wheels are missing."
    }
    Write-Host "  Native Linux extensions bundled: $soCount" -ForegroundColor DarkGray
}

if (-not (Test-Path $buildDir)) {
    throw "Build directory missing. Re-run without -SkipDeps."
}

Write-Host "Copying handler source" -ForegroundColor Cyan
Copy-Item (Join-Path $sourceDir "handler.py") (Join-Path $buildDir "handler.py") -Force

$sizeMb = [math]::Round(
    ((Get-ChildItem -Path $buildDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host "API Lambda bundle ready: $buildDir ($sizeMb MB uncompressed)" -ForegroundColor Green
