# Windows Setup Script for WinTun
# Run this script as Administrator to download and setup WinTun

param(
    [string]$Version = "0.14.1",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "This script must be run as Administrator"
    exit 1
}

Write-Host "Setting up WinTun for appium-ios-tuntap..." -ForegroundColor Green

# Determine architecture
$arch = if ([Environment]::Is64BitOperatingSystem) {
    if ([Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") -eq "ARM64") {
        "arm64"
    } else {
        "amd64"
    }
} else {
    "x86"
}

Write-Host "Detected architecture: $arch" -ForegroundColor Cyan

# Download WinTun
$wintunUrl = "https://www.wintun.net/builds/wintun-$Version.zip"
$tempZip = Join-Path $env:TEMP "wintun-$Version.zip"
$tempExtract = Join-Path $env:TEMP "wintun-$Version"

Write-Host "Downloading WinTun $Version..." -ForegroundColor Yellow
try {
    Invoke-WebRequest -Uri $wintunUrl -OutFile $tempZip -UseBasicParsing
    Write-Host "Download completed" -ForegroundColor Green
} catch {
    Write-Error "Failed to download WinTun: $_"
    exit 1
}

# Extract ZIP
Write-Host "Extracting WinTun..." -ForegroundColor Yellow
if (Test-Path $tempExtract) {
    Remove-Item -Path $tempExtract -Recurse -Force
}
Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force

# Find the DLL
$dllSource = Join-Path $tempExtract "wintun\bin\$arch\wintun.dll"
if (-not (Test-Path $dllSource)) {
    Write-Error "Could not find wintun.dll for architecture $arch"
    exit 1
}

# Copy to multiple locations for convenience
$locations = @(
    (Join-Path $PSScriptRoot "build\Release"),
    (Join-Path $PSScriptRoot "bin"),
    $PSScriptRoot
)

Write-Host "Installing wintun.dll..." -ForegroundColor Yellow
foreach ($location in $locations) {
    if (-not (Test-Path $location)) {
        New-Item -ItemType Directory -Path $location -Force | Out-Null
    }

    $dllDest = Join-Path $location "wintun.dll"
    if ((Test-Path $dllDest) -and -not $Force) {
        Write-Host "  Skipping $dllDest (already exists, use -Force to overwrite)" -ForegroundColor Gray
    } else {
        Copy-Item -Path $dllSource -Destination $dllDest -Force
        Write-Host "  Installed to: $dllDest" -ForegroundColor Green
    }
}

# Cleanup
Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue
Remove-Item -Path $tempExtract -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "WinTun setup completed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Build the native addon: npm run build:addon" -ForegroundColor White
Write-Host "  2. Build TypeScript: npm run build" -ForegroundColor White
Write-Host "  3. Run your application as Administrator" -ForegroundColor White
Write-Host ""
Write-Host "See WINDOWS.md for more information." -ForegroundColor Cyan
