$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $projectDir "tools"
$runDir = Join-Path $projectDir ".run"
$envPath = Join-Path $projectDir ".env"
$cloudflaredPath = Join-Path $toolsDir "cloudflared.exe"
$tunnelLog = Join-Path $runDir "cloudflared.log"
$serverLog = Join-Path $runDir "server.log"

New-Item -ItemType Directory -Force -Path $toolsDir, $runDir | Out-Null

if (Test-Path (Join-Path $runDir "server.pid")) {
    throw "A saved server process exists. Run 'npm run stop' first."
}

if (-not (Test-Path $cloudflaredPath)) {
    Write-Host "Downloading Cloudflare Tunnel..."
    Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $cloudflaredPath
}

if (-not (Test-Path $envPath)) {
    Copy-Item (Join-Path $projectDir ".env.example") $envPath
}

$tokenBytes = New-Object byte[] 32
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
$random.GetBytes($tokenBytes)
$random.Dispose()
$token = ([BitConverter]::ToString($tokenBytes) -replace '-', '').ToLowerInvariant()

$envText = Get-Content -LiteralPath $envPath -Raw
$envText = [regex]::Replace($envText, '(?m)^HTTP_TOKEN=.*$', "HTTP_TOKEN=$token")
$envText = [regex]::Replace($envText, '(?m)^PUBLIC_BASE_URL=.*$', 'PUBLIC_BASE_URL=http://127.0.0.1:8788')
Set-Content -LiteralPath $envPath -Value $envText -Encoding utf8

Remove-Item -LiteralPath $tunnelLog, $serverLog -Force -ErrorAction SilentlyContinue
$tunnel = Start-Process -FilePath $cloudflaredPath -ArgumentList @("tunnel", "--url", "http://127.0.0.1:8788", "--no-autoupdate", "--logfile", $tunnelLog) -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $runDir "tunnel.pid") -Value $tunnel.Id

$publicBaseUrl = $null
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $tunnelLog) {
        $match = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
        if ($match) {
            $publicBaseUrl = $match.Matches[0].Value
            break
        }
    }
    if ($tunnel.HasExited) { break }
}

if (-not $publicBaseUrl) {
    if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id }
    Remove-Item -LiteralPath (Join-Path $runDir "tunnel.pid") -Force -ErrorAction SilentlyContinue
    throw "Cloudflare Tunnel did not return a public URL. See $tunnelLog"
}

$envText = Get-Content -LiteralPath $envPath -Raw
$envText = [regex]::Replace($envText, '(?m)^PUBLIC_BASE_URL=.*$', "PUBLIC_BASE_URL=$publicBaseUrl")
Set-Content -LiteralPath $envPath -Value $envText -Encoding utf8

$nodePath = (Get-Command node -ErrorAction Stop).Source
$tsxCli = Join-Path $projectDir "node_modules\tsx\dist\cli.mjs"
$server = Start-Process -FilePath $nodePath -ArgumentList @($tsxCli, "src/server.ts") -WorkingDirectory $projectDir -RedirectStandardOutput $serverLog -RedirectStandardError (Join-Path $runDir "server-error.log") -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $runDir "server.pid") -Value $server.Id

for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:8788/health" -TimeoutSec 2
        if ($health.ok) { break }
    } catch {}
}

if (-not $health.ok) {
    & (Join-Path $PSScriptRoot "stop-public.ps1")
    throw "The MCP server did not become healthy. See $serverLog"
}

$publicReady = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $publicHealth = Invoke-RestMethod -Uri "$publicBaseUrl/health" -TimeoutSec 3
        if ($publicHealth.ok) {
            $publicReady = $true
            break
        }
    } catch {}
}

if (-not $publicReady) {
    & (Join-Path $PSScriptRoot "stop-public.ps1")
    throw "The public tunnel did not become reachable. See $tunnelLog"
}

Write-Host ""
Write-Host "RVC Voice MCP is online." -ForegroundColor Green
Write-Host "ChatGPT connector URL:" -ForegroundColor Cyan
Write-Host "$publicBaseUrl/mcp?token=$token"
Write-Host ""
Write-Host "Run 'npm run stop' when finished."
