# Looks up one order by ClientRefNo via the real Axis REST API and prints the
# full order (pickup, delivery, POD, charges, etc.) — the reference-number
# equivalent of test-axis-token.ps1 / getOrderByReferenceFromAxis() in
# src/lib/axis-api.ts. Run this yourself, not from an agent sandbox, since it
# sends real credentials to a live production server.
#
# Usage: powershell -File scripts\test-axis-reference.ps1 -ReferenceNumber "YOUR-REF-HERE"

param(
    [Parameter(Mandatory = $true)]
    [string]$ReferenceNumber
)

$envFile = Join-Path $PSScriptRoot "..\.env.local"
$envVars = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)\s*$') {
        $envVars[$matches[1]] = $matches[2]
    }
}

$username = $envVars["AXIS_USERNAME"]
$password = $envVars["AXIS_PASSWORD"]
$baseUrl  = if ($envVars["AXIS_API_BASE_URL"]) { $envVars["AXIS_API_BASE_URL"] }
            elseif ($envVars["AXIS_PORTAL_BASE_URL"]) { "$($envVars['AXIS_PORTAL_BASE_URL'].TrimEnd('/'))/Axis" }
            else { "https://skylinecourierlogistics.com/Xcelerator/Axis" }

if (-not $username -or -not $password) {
    Write-Host "AXIS_USERNAME / AXIS_PASSWORD not found in .env.local" -ForegroundColor Red
    exit 1
}

# AXIS_API_TOKEN overrides the Basic-auth guess, same as axis-api.ts.
$authValue = if ($envVars["AXIS_API_TOKEN"]) {
    $envVars["AXIS_API_TOKEN"]
} else {
    "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${username}:${password}"))
}

$fields = @("ClientRefNo", "ClientRefNo2", "ClientRefNo3", "ClientRefNo4")

foreach ($field in $fields) {
    $url = "$baseUrl/v4/Order/GetOrderByReference?clientRefNo=$field&value=$([Uri]::EscapeDataString($ReferenceNumber))&includeDocuments=true&includePackages=true"
    Write-Host "`n=== GET $url ===" -ForegroundColor Cyan
    try {
        $resp = Invoke-RestMethod -Uri $url -Method Get -Headers @{ Accept = "application/json"; Authorization = $authValue } -ErrorAction Stop
        if ($resp -and $resp.Count -gt 0) {
            Write-Host "MATCH on $field :" -ForegroundColor Green
            $resp | ConvertTo-Json -Depth 8
            break
        } else {
            Write-Host "No match on $field (empty array)." -ForegroundColor DarkGray
        }
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        Write-Host "HTTP $statusCode" -ForegroundColor Yellow
        if ($_.Exception.Response) {
            $stream = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $reader.BaseStream.Position = 0
            $text = $reader.ReadToEnd()
            Write-Host $text.Substring(0, [Math]::Min(500, $text.Length))
            # An auth failure (401/403) will look the same on every field —
            # no point retrying the rest with the same bad credential.
            if ($statusCode -eq 401 -or $statusCode -eq 403) { break }
        }
    }
}
