# Probes a few likely OAuth2 password-grant /token endpoints for the real
# Xcelerator AXIS API, using the credentials already in .env.local. Run this
# yourself (not from an agent sandbox) since it sends real credentials to a
# live production server.
#
# Usage: powershell -File scripts\test-axis-token.ps1

$envFile = Join-Path $PSScriptRoot "..\.env.local"
$envVars = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)\s*$') {
        $envVars[$matches[1]] = $matches[2]
    }
}

$username = $envVars["AXIS_USERNAME"]
$password = $envVars["AXIS_PASSWORD"]

if (-not $username -or -not $password) {
    Write-Host "AXIS_USERNAME / AXIS_PASSWORD not found in .env.local" -ForegroundColor Red
    exit 1
}

$candidates = @(
    "https://skylinecourierlogistics.com/Xcelerator/Axis/token",
    "https://skylinecourierlogistics.com/Xcelerator/token",
    "https://skylinecourierlogistics.com/token"
)

$body = @{
    grant_type = "password"
    username   = $username
    password   = $password
}

foreach ($url in $candidates) {
    Write-Host "`n=== POST $url ===" -ForegroundColor Cyan
    try {
        $resp = Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType "application/x-www-form-urlencoded" -ErrorAction Stop
        Write-Host "SUCCESS:" -ForegroundColor Green
        $resp | ConvertTo-Json -Depth 5
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        Write-Host "HTTP $statusCode" -ForegroundColor Yellow
        if ($_.Exception.Response) {
            $stream = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $reader.BaseStream.Position = 0
            $text = $reader.ReadToEnd()
            Write-Host $text.Substring(0, [Math]::Min(500, $text.Length))
        }
    }
}
