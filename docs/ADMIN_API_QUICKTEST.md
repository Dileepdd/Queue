# Admin API Quick Test

This guide is a fast, copy-paste checklist to verify admin key-management APIs.

## Where To Set Values (Important)

Set values in two separate places:

1. Service runtime config (`c:\Queue\.env`):

```dotenv
AUTH_HMAC_REQUIRED=true
AUTH_BEARER_ENABLED=true
AUTH_CLOCK_SKEW_MS=300000
AUTH_NONCE_TTL_MS=300000
ADMIN_API_TOKEN=replace-with-strong-admin-token
```

2. Postman environment variables (for sending requests):

- `adminToken` = same value as `ADMIN_API_TOKEN`
- `accessToken` = API client secret from create/rotate response
- `accessKeyId` + `secretKey` only for HMAC compatibility mode
- `tenantId` = tenant id for job payloads (example `tenant1`)

If you change any value in `.env`, restart producer.

## Prerequisites

- Producer is running.
- `ADMIN_API_TOKEN` is set in `.env` and the producer was restarted.
- Base URL is reachable (default `http://localhost:3000`).

Set variables in PowerShell first:

```powershell
$baseUrl = 'http://localhost:3000'
$adminToken = 'replace-with-your-admin-token'
```

## 1. Health Check (sanity)

```powershell
Invoke-RestMethod -Method Get -Uri "$baseUrl/health"
```

Expected: `ok=true`.

## 2. List Existing Keys

```powershell
Invoke-RestMethod -Method Get -Uri "$baseUrl/admin/keys" -Headers @{ 'X-Admin-Token' = $adminToken }
```

Expected: `200` response with `items` array.

## 3. Create New Key

```powershell
$createBody = @{
  tenantId = 'tenant1'
  clientName = 'Quicktest Client'
} | ConvertTo-Json

$created = Invoke-RestMethod -Method Post -Uri "$baseUrl/admin/keys" -Headers @{ 'X-Admin-Token' = $adminToken } -ContentType 'application/json' -Body $createBody
$created
```

Expected:

- Status `201`
- Response includes `keyId` and `secretValue`

Save these for later steps:

```powershell
$keyId = $created.keyId
$secretValue = $created.secretValue
```

## 4. Rotate Key Secret

```powershell
$rotated = Invoke-RestMethod -Method Post -Uri "$baseUrl/admin/keys/$keyId/rotate" -Headers @{ 'X-Admin-Token' = $adminToken }
$rotated
```

Expected:

- Status `200`
- Response includes new `secretValue`

Replace local variable with rotated secret:

```powershell
$secretValue = $rotated.secretValue
```

## 5. Revoke Key

```powershell
Invoke-RestMethod -Method Post -Uri "$baseUrl/admin/keys/$keyId/revoke" -Headers @{ 'X-Admin-Token' = $adminToken }
```

Expected:

- Status `200`
- `revoked=true`

## 6. Verify Key Is Revoked

```powershell
Invoke-RestMethod -Method Get -Uri "$baseUrl/admin/keys" -Headers @{ 'X-Admin-Token' = $adminToken }
```

Expected:

- The same `keyId` appears with `status` set to `revoked`.

## Negative Tests

## A) Missing Admin Token

```powershell
Invoke-RestMethod -Method Get -Uri "$baseUrl/admin/keys"
```

Expected: `401` with code `ADMIN_AUTH_MISSING_TOKEN`.

## B) Invalid Admin Token

```powershell
Invoke-RestMethod -Method Get -Uri "$baseUrl/admin/keys" -Headers @{ 'X-Admin-Token' = 'bad-token' }
```

Expected: `401` with code `ADMIN_AUTH_INVALID_TOKEN`.

## C) Rotate Unknown Key

```powershell
Invoke-RestMethod -Method Post -Uri "$baseUrl/admin/keys/client_unknown_001/rotate" -Headers @{ 'X-Admin-Token' = $adminToken }
```

Expected: `404` with code `ADMIN_KEY_NOT_FOUND`.

## Notes

- Rotate updates secret while keeping key id.
- Revoke disables key entirely, including bearer-token access.
- Keep `secretValue` secure and never commit real values to git.
