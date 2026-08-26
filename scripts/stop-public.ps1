$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $projectDir ".run"

foreach ($name in @("server", "tunnel")) {
    $pidPath = Join-Path $runDir "$name.pid"
    if (-not (Test-Path $pidPath)) { continue }

    $processId = [int](Get-Content -LiteralPath $pidPath -Raw)
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) {
        $expected = if ($name -eq "server") { @("node", "npm") } else { @("cloudflared") }
        if ($expected -notcontains $process.ProcessName) {
            throw "Refusing to stop unexpected process $($process.ProcessName) with PID $processId."
        }
        Stop-Process -Id $processId
        Write-Host "Stopped $name process ($processId)."
    }
    Remove-Item -LiteralPath $pidPath -Force
}
