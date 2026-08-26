param(
    [Parameter(Mandatory = $true)]
    [string]$AudioPath
)

$ErrorActionPreference = "Stop"
$resolvedAudioPath = (Resolve-Path -LiteralPath $AudioPath).Path
$player = [System.Media.SoundPlayer]::new($resolvedAudioPath)
$player.PlaySync()
