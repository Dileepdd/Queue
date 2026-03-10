$baseUrl = if ($env:VALIDATION_BASE_URL) { $env:VALIDATION_BASE_URL } else { "http://localhost:3000" }
$accessToken = if ($env:VALIDATION_ACCESS_TOKEN) { $env:VALIDATION_ACCESS_TOKEN } else { $env:ACCESS_TOKEN }

if (-not $accessToken) {
  Write-Error "Missing access token. Set VALIDATION_ACCESS_TOKEN (or ACCESS_TOKEN) before running validation scripts."
  exit 1
}

$idem = "tenant1:webhook.dispatch:event:duplicate:v1-" + [guid]::NewGuid().ToString("N")
$payload = @{
  job = @{
    name = "webhook.dispatch"
    metadata = @{
      idempotencyKey = $idem
      correlationId = "corr-" + [guid]::NewGuid().ToString("N").Substring(0, 12)
      requestedAt = (Get-Date).ToUniversalTime().ToString("o")
      tenantId = "tenant1"
      schemaVersion = 1
      priority = "high"
      workload = "io-bound"
      partitionKey = "tenant1-webhook"
    }
    payload = @{
      endpoint = "https://httpbin.org/post"
      method = "POST"
      eventType = "validation.duplicate"
      headers = @{ "X-Validation" = "duplicate-test" }
      data = @{ message = "Duplicate webhook payload" }
    }
  }
}

$json = $payload | ConvertTo-Json -Depth 10

Write-Output "First submit"
Invoke-RestMethod -Method Post -Uri "$baseUrl/jobs" -Headers @{ Authorization = "Bearer $accessToken" } -ContentType "application/json" -Body $json

Start-Sleep -Seconds 1

Write-Output "Second submit (same idempotency key)"
Invoke-RestMethod -Method Post -Uri "$baseUrl/jobs" -Headers @{ Authorization = "Bearer $accessToken" } -ContentType "application/json" -Body $json

Write-Output "idempotencyKey=$idem"
