$idem = "tenant1:email.send:user123:send:v1-" + [guid]::NewGuid().ToString("N")
$payload = @{
  job = @{
    name = "email.send"
    metadata = @{
      idempotencyKey = $idem
      correlationId = "corr-" + [guid]::NewGuid().ToString("N").Substring(0, 12)
      requestedAt = (Get-Date).ToUniversalTime().ToString("o")
      tenantId = "tenant1"
      schemaVersion = 1
      priority = "default"
      workload = "io-bound"
    }
    payload = @{
      to = "test@example.com"
      subject = "Duplicate test"
      body = "Test message"
    }
  }
}

$json = $payload | ConvertTo-Json -Depth 10

Write-Output "First submit"
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/jobs" -ContentType "application/json" -Body $json

Start-Sleep -Seconds 1

Write-Output "Second submit (same idempotency key)"
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/jobs" -ContentType "application/json" -Body $json

Write-Output "idempotencyKey=$idem"
