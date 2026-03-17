# Scheduler Lean Rebuild — Analysis & Requirements

---

## Developer Message — Route Audit Request

> Copy and send this to the team / post in the relevant Slack channel or ticket.

---

Hi team,

We are planning to separate the **cron/scheduler service** into a lean standalone service, as the current project has grown to **60+ route files** but we are actively using only **~14 routes**.

To make sure we don't break anything, I've done a full audit of all calls being made to the scheduler from `api.esigns.io`, the internal self-calls, and the EasyCron-triggered endpoints. Below is the complete list of routes we have identified so far.

**Please review and confirm — if you are calling any scheduler route from any other place (feature branch, new service, mobile app, a script, etc.) that is NOT in this list, reply with the route and the file/service calling it.**

---

### Routes we have identified as actively used:

**Called from `api.esigns.io`:**

| # | Method | Route |
|---|--------|-------|
| 1 | `POST` | `/v1.0/automation` |
| 2 | `POST` | `/v1.0/automation-rerun/process` |
| 3 | `GET`  | `/v1.0/entity-action-schedules/:entity_id/:automation_id` |
| 4 | `POST` | `/v1.0/form-builder/automation` |
| 5 | `POST` | `/v1.0/form-builder/automation/advanced-approvals` |
| 6 | `POST` | `/v1.0/bulk-upload-files` |
| 7 | `POST` | `/v1.0/importMappedEntityData` |
| 8 | `GET`  | `/v1.0/export/entities-data/zip/:entityId` |
| 9 | `GET`  | `/v1.0/tiny_url/file-download/:file_path` |
| 10 | `POST` | `/v1.0/micro-service-export-log/:entity_id/:time_stamp` |

**Triggered by EasyCron (scheduled jobs — no direct API call):**

| # | Method | Route |
|---|--------|-------|
| 11 | `GET` | `/v1.0/delay-automation` |
| 12 | `GET` | `/v1.0/entity-action-schedules/:entity_id/:automation_id` *(same as #3, called by EasyCron webhook)* |
| 13 | `GET` | `/v1.0/entity-automation/:entity_id/:automation_id` |

**Self-called by the scheduler service internally:**

| # | Method | Route |
|---|--------|-------|
| 14 | `POST` | `/v1.0/automation-rerun/process` *(recursive pagination)* |
| 15 | `POST` | `/v1.0/bulk-update-data` |
| 16 | `POST` | `/v1.0/integrations/process-external-source-batch-data/:pipelineId/:actionIndex/:randomKey` |

---

**If you are using any route from the scheduler that is not in this list, please share:**
1. The full route path and HTTP method
2. The file or service making the call
3. A brief description of what it does

This will ensure nothing gets dropped during the migration.

Thanks!

---

## TL;DR

The current `schedulers` project has **60+ route files** and **~20+ controllers**, but `api.esigns.io` only calls **10 routes** across **5 route files**. This document identifies exactly what to keep, what each route needs, and what environment variables are required for a clean TypeScript rebuild.

---

## 1. Routes Actually Used by `api.esigns.io`

These are the only routes that `api.esigns.io` calls via `config.microservices.cronUrl`:

| # | Method | Route | Source File in api.esigns.io | Current Route File |
|---|--------|--------|-------------------------------|-------------------|
| 1 | `POST` | `/v1.0/automation` | `src/utils/event-listener.ts` | `cronJobs.ts` |
| 2 | `POST` | `/v1.0/automation-rerun/process` | `src/controllers/automationRerunController.ts` | `cronJobs.ts` |
| 3 | `GET`  | `/v1.0/entity-action-schedules/:entity_id/:automation_id` | `src/helpers/scheduleHelper.ts` (via EasyCron webhook) | `cronJobs.ts` |
| 4 | `POST` | `/v1.0/form-builder/automation` | `src/controllers/helpers/generalHelper.ts` | `cronJobs.ts` |
| 5 | `POST` | `/v1.0/form-builder/automation/advanced-approvals` | `src/controllers/helpers/generalHelper.ts` | `cronJobs.ts` |
| 6 | `POST` | `/v1.0/bulk-upload-files` | `src/controllers/excelEntityDataController.ts` | `cronJobs.ts` |
| 7 | `POST` | `/v1.0/importMappedEntityData` | `src/controllers/excelEntityDataController.ts` | `entityEvents.ts` |
| 8 | `GET`  | `/v1.0/export/entities-data/zip/:entityId` | `src/controllers/excelEntityDataController.ts` | `excelEntityData.ts` |
| 9 | `GET`  | `/v1.0/tiny_url/file-download/:file_path` | `src/controllers/templateDataController.ts` | `preSignedUrl.ts` |
| 10 | `POST` | `/v1.0/micro-service-export-log/:entity_id/:time_stamp` | `src/controllers/helpers/ActivityHelper.ts` | `WebHooks.ts` |

> **Note:** EasyCron.com calls route #3 directly as a webhook based on the schedule configured by `scheduleHelper.ts`.

---

## 2. Routes Internally Triggered (No External Caller, but Required)

These routes are not called by `api.esigns.io` directly but are triggered by cron jobs or internal queue logic:

| # | Method | Route | Trigger | Current Route File |
|---|--------|--------|---------|-------------------|
| 11 | `GET` | `/v1.0/delay-automation` | EasyCron.com scheduled job | `cronJobs.ts` |
| 12 | `POST` | `/v1.0/bulk-update-data` | AWS SQS queue consumer | `cronJobs.ts` |
| 13 | `GET` | `/v1.0/entity-automation/:entity_id/:automation_id` | EasyCron.com (rare fallback path) | `cronJobs.ts` |

---

## 3. Controller Method → Dependency Mapping

### 3.1 `cron.controller.ts` — Routes 1–6, 11–13

The heaviest controller. Handles automation pipelines, form-builder triggers, bulk uploads, and delay checks.

**Methods needed:**
- `checkAutomationPipeline` — entity automation triggers, reads DB, fires pipeline
- `handleAutomationRerun` — re-processes failed/queued automation jobs
- `performSchedules` — checks scheduled entity actions, triggers per matching record
- `checkFormbuilderAutomationPipeline` — form-builder automation
- `checkFormbuilderAdvancedApprovals` — advanced approval automation
- `bulkUploadDocuments` — processes bulk S3 uploads
- `checkDelayedPipelines` — processes delay-queue actions (runs on a cron)
- `bulkUpdateData` — processes SQS-triggered bulk data updates
- `entityAutomation` — fallback trigger path for entity automations

**Key internal helpers imported by `cron.controller.ts`:**
- `automationHelper` — the core pipeline engine (deep MongoDB queries, email, webhooks)
- `generalHelper` — utility functions shared across the codebase
- `emailHelper` / `smtpEmailServiceProvider` — email sending
- `s3DataServiceProvider` — S3 file operations
- AWS SQS consumer — for `bulk-update-data`

### 3.2 `entityEventsController` — Route 7 (`importMappedEntityData`)

Handles zip-file import of entity data.

**Methods needed:**
- `importZipData` — downloads a zip from S3, extracts, processes mapped entity imports

**Key dependencies:**
- `s3DataServiceProvider` — download files from S3
- `excelEntityDataHelper` — Excel parsing and mapping
- MongoDB — entity/template data writes

### 3.3 `excelEntityDataController` — Route 8 (`export/entities-data/zip/:entityId`)

Exports entity files as a zip.

**Methods needed:**
- `exportEntityFilesAsZIP` — queries S3 for entity files, zips them, streams back

**Key dependencies:**
- `s3DataServiceProvider` — fetch files from S3
- `adm-zip` npm package — zip file creation

### 3.4 `preSignedController` — Route 9 (`tiny_url/file-download/:file_path`)

Returns a redirect to a short-lived S3 pre-signed URL for file download.

**Methods needed:**
- `file_download_tiny_url` — generates pre-signed URL and redirects

**Key dependencies:**
- `s3DataServiceProvider` / `preSignS3DataServiceProvider` — generate pre-signed URL
- AWS SDK S3

### 3.5 `webhookController` — Route 10 (`micro-service-export-log`)

Records export log from the main API.

**Methods needed:**
- `exportEntityDataLogMicroservice` — saves export log record to MongoDB

**Key dependencies:**
- `entityEventsDataServiceProvider` — MongoDB write

---

## 4. Internal Self-Calls & Cross-Service API Calls

The scheduler does not just receive external traffic — it also **calls itself** and **calls the main API** internally. These are critical to keep wired correctly in any rebuild.

### 4.1 Scheduler → Itself (`current_api_url`)

These are routes the scheduler calls on itself. `CURRENT_API_URL` must be set to the scheduler's own base URL.

| Source File | Line | Route Called | Why |
|-------------|------|-------------|-----|
| `cron.controller.ts` | 1161 | `POST /v1.0/automation-rerun/process` | Recursive: `handleAutomationRerun` pages through batches by calling itself |
| `cron.controller.ts` | 2001 | `POST /v1.0/bulk-update-data` | AWS SNS subscription confirmation — SNS calls back the same endpoint to verify |
| `automationHelper.ts` | 3579 | `POST /v1.0/integrations/process-external-source-batch-data/:pipelineId/:actionIndex/:randomKey` | External source import — sets this as `notification_url` so external integration calls back after importing data |
| `automationHelper.ts` | 3750 | `GET /v1.0/tiny_url/file-download/:file_path` | Builds file download URL for external source export payload |
| `EntityHelper.ts` | 1808 | `POST /v1.0/automation` | After bulk-inserting entity records from import, fires automation for each new record |

> **Implication for lean rebuild:** The `apiIntegrations.ts` route (`/integrations/process-external-source-batch-data/...`) must also be kept — it is called back by the external integration service.

### 4.2 Scheduler → Main API (`api_base_url` = `api.esigns.io`)

The scheduler calls these routes on the main backend. `API_URL` must point to the live main API.

| Source File | Route Called on Main API | Purpose |
|-------------|--------------------------|---------|
| `automationHelper.ts` | `POST /v1.0/entities-data/check` | Read entity data during pipeline execution |
| `automationHelper.ts` | `POST /v1.0/entities-data/entity/data/v2` | Filtered entity data query (2×) |
| `automationHelper.ts` | `POST /v1.0/action/entities-data/bulk-update` | Bulk-update entity records from pipeline |
| `automationHelper.ts` | `POST /v1.0/send-data-to-webhooks` | Notify outbound webhooks after entity create/delete (3×) |
| `automationHelper.ts` | `POST /v1.0/export/entities-data/v2/:entityId` | Trigger export for external source pipeline action |
| `automationHelper.ts` | `POST /v1.0/documents/send-workflow/schedulers` | Send document workflow from automation action |
| `automationHelper.ts` | `POST /v1.0/schedulers/document-templates/documents/draft` | Save document draft from automation |
| `automationHelper.ts` | `POST /v1.0/document-templates/documents/schedulers/send-template` | Send doc template from automation |
| `automationHelper.ts` | `POST /v1.0/formbuilder-data/template` | Create formbuilder data when automation sends approval form |
| `automationHelper.ts` | `POST /v1.0/formbuilder-data/check` | Check formbuilder access/existence |
| `entityHelperV2.ts` | `POST /v1.0/action/entities-data/bulk-update` | Bulk action from `UPDATE_ALL` pipeline step |
| `fieldMappingHelper.ts` | `POST /v1.0/template-data/auto-increment` | Auto-increment field value generation |
| `formBuilderController.ts` | `GET /v1.0/workflow-schedules/:id` *(via EasyCron callback)* | EasyCron webhook target for form workflow schedules |
| `formBuilderController.ts` | `GET /v1.0/workflow-reminders/:id` *(via EasyCron callback)* | EasyCron webhook target for form reminders |

### 4.3 Scheduler → Queue Service (`apiURL_Queue`)

Two routes call out to the Queue/notification service (separate from the main API):

| Source File | Route Called | Purpose |
|-------------|-------------|---------|
| `entityEventsController.ts` | `POST {apiURL_Queue}/v1.0/sendBulkNotifications` | Delegates bulk notification jobs to the queue worker |
| `excelEntityDataController.ts` | `POST {apiURL_Queue}/v1.0/importData` | Delegates import batches to the queue worker |

> These require `AWS_QUEUE_SERVICE_API` + `AWS_QUEUE_SERVICE_TOKEN` env vars.

### 4.4 External Service → Scheduler (inbound from EasyCron.com)

EasyCron.com calls the scheduler on these routes (configured by `scheduleHelper.ts`). These must be publicly reachable:

| Route | Triggered by |
|-------|-------------|
| `GET /v1.0/entity-action-schedules/:entity_id/:automation_id` | EasyCron field-date and recurring schedules |
| `GET /v1.0/delay-automation` | EasyCron periodic job |

### 4.5 Identified Bug: Wrong URL Variable

`cron.controller.ts` line 1506 uses `api_base_url` (main API) to build a `tiny_url/file-download` URL, but that route lives in the scheduler itself:

```typescript
// BUG: uses api_base_url — should be current_api_url
`${config.app.api_base_url}/v1.0/tiny_url/file-download/${output}`
```

This means in production with separate deployments the built short-URL points to the wrong host. Fix: change `api_base_url` → `current_api_url` here to match `automationHelper.ts:3750`.

---

## 5. Required Environment Variables

Only the env vars actually used by the 10 kept routes. Variables are grouped by function.

### Core Service
```env
NODE_ENV=dev
PORT=3001
APP_URL=https://api.esigns.io
API_URL=https://api.esigns.io
UI_APP_URL=https://app.esigns.io
API_VERSION=v1.0
CURRENT_API_URL=http://localhost:3001
```

### MongoDB
```env
MONGO_CONNECTION_STRING=mongodb+srv://...     # Required by all controllers
```

### JWT Auth (for authMiddleware on guarded routes)
```env
JWT_ACCESS_TOKEN_SECRET=...
JWT_REFRESH_TOKEN_SECRET=...
```

### AWS S3 (for bulk upload, zip export, file download, import)
```env
AWS_S3_ACCESS_KEY_ID=...
AWS_S3_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET=...
S3_BASE_URL=https://...s3.amazonaws.com/
PRE_SIGNED_URL_EXPIRES=3600
AWS_PRE_SIGNED_S3_ACCESS_KEY_ID=...
AWS_PRE_SIGNED_S3_SECRET_ACCESS_KEY=...
AWS_PRE_SIGNED_S3_BUCKET=...
AWS_PRE_SIGNED_S3_REGION=ap-south-1
PRE_SIGNED_S3_BASE_URL=https://...
```

### Email (automation pipeline sends emails)
```env
SENDGRID_API_KEY=...
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_SENDER_EMAIL=...
NOTIFY_AUTHORIZATION_EMAIL=...
NOTIFY_AUTHORIZATION_TOKEN=...
NOTIFY_AUTHORIZATION_SENDER=...
EMAIL_NOTIFICATIONS_BASE_URL=https://...
```

### EasyCron (schedule create/update/delete)
```env
EASY_CRON_TOKEN=...
CRON_GROUP_ID=...
CRON_GROUP_PREFIX=...
```

### AWS SQS (for bulk-update-data route)
```env
AWS_QUEUE_BULK_UPDATE=https://sqs.ap-south-1.amazonaws.com/...
```

### Queue Service Integration (scheduler sends jobs to queue worker)
```env
AWS_QUEUE_SERVICE_API=https://...             # Queue service base URL (apiURL_Queue)
AWS_QUEUE_SERVICE_TOKEN=...                   # Queue auth token
```

### Error Tracking (optional but recommended)
```env
SENTRY_DNS=https://...
```

### Can Be Removed from Lean Build
These env vars exist in `.env.dev` but are NOT needed by the 10 kept routes:
- `STRIPE_SECRET_KEY`, `PAYMENT_GATEWAY_*`, `PAYMENT_WEBHOOK_URL`
- `WHATSAPP_*`, `WBA_WHATSAPP_*`
- `IP_GEOLOCATION_API_KEY`
- `SSO_AUTHFAST_API_BASE_URL`
- `JAVA_BASE_URL`

---

## 5. Files to Keep in Lean Rebuild

### Routes (6 files)
```
src/routes/index.ts              # Mount all routes under /v1.0
src/routes/cronJobs.ts           # Routes 1–6, 11–13
src/routes/entityEvents.ts       # Route 7: importMappedEntityData
src/routes/excelEntityData.ts    # Route 8: export/entities-data/zip
src/routes/preSignedUrl.ts       # Route 9: tiny_url/file-download
src/routes/WebHooks.ts           # Route 10: micro-service-export-log
src/routes/apiIntegrations.ts    # Self-callback: /integrations/process-external-source-batch-data
```

### Controllers (5 files)
```
src/controllers/cron.controller.ts
src/controllers/entityEventsController.ts    (only importZipData method)
src/controllers/excelEntityDataController.ts (only exportEntityFilesAsZIP method)
src/controllers/preSignedUrlController.ts    (only file_download_tiny_url method)
src/controllers/webhookController.ts         (only exportEntityDataLogMicroservice method)
```

### Core Helpers/Services (keep full)
```
src/helpers/automationHelper.ts     # Core pipeline engine
src/helpers/generalHelper.ts        # Shared utility functions
src/helpers/emailHelper.ts          # Email composition
src/helpers/easyCronHelper.ts       # EasyCron integration
src/services/database/             # All MongoDB service providers used by above
src/middlewares/authMiddleware.ts   # JWT auth middleware
src/middlewares/validations/       # Schema validators
```

### Config & Infrastructure
```
config/app.ts                       # Main config file
src/app.ts                          # Express app setup
src/server.ts                       # Entry point
tsconfig.json
package.json (trimmed dependencies)
```

### Models (keep only used ones)
```
src/models/automationLogs.ts
src/models/automationRerun.ts
src/models/delayActions.ts
src/models/defaultEntityData.ts
src/models/applicationCloningJobsModel.ts (if referenced by automation)
```

---

## 6. Files to Remove

All of these exist in the current project but are NOT needed for the 10 routes:

```
src/routes/company.ts
src/routes/user.ts
src/routes/template.ts
src/routes/templateData.ts
src/routes/formBuilders.ts
src/routes/formBuildersData.ts
src/routes/applicationUsers.ts
src/routes/applicationUserPermissions.ts
src/routes/role.ts
src/routes/permissions.ts
src/routes/plans.ts
src/routes/stripe.ts
src/routes/paymentGateway.ts
src/routes/oAuth.ts
src/routes/oAuthKeys.ts
src/routes/notifications.ts
src/routes/fileManagement.ts
src/routes/fileUpload.ts
src/routes/email*.ts
src/routes/category.ts
src/routes/contactUs.ts
src/routes/createApp.ts
src/routes/customDashboard.ts
src/routes/entity.ts
src/routes/entityGroups.ts
src/routes/entityRelationship.ts
src/routes/entityViewConfiguration.ts
src/routes/eSigns.ts
src/routes/features.ts
src/routes/feedback.ts
src/routes/filters.ts
src/routes/globalVariables.ts
src/routes/globalVariableTag.ts
src/routes/industryTypes.ts
src/routes/menuManagement.ts
src/routes/quickBooks.ts
(and ~20 more)
```

---

## 7. Recommended Lean Folder Structure (New TypeScript Project)

```
lean-scheduler/
├── src/
│   ├── server.ts                    # Entry point
│   ├── app.ts                       # Express setup
│   ├── routes/
│   │   ├── index.ts                 # Mount all at /v1.0
│   │   ├── cron.routes.ts           # All cronJobs routes
│   │   ├── import.routes.ts         # importMappedEntityData
│   │   ├── export.routes.ts         # export/entities-data/zip
│   │   ├── files.routes.ts          # tiny_url/file-download
│   │   └── webhooks.routes.ts       # micro-service-export-log
│   ├── controllers/
│   │   ├── cron.controller.ts
│   │   ├── import.controller.ts
│   │   ├── export.controller.ts
│   │   ├── files.controller.ts
│   │   └── webhooks.controller.ts
│   ├── services/
│   │   ├── automation/              # Pipeline logic
│   │   ├── formbuilder/             # Form-builder automations
│   │   ├── email/                   # Email sending
│   │   ├── s3/                      # S3 file operations
│   │   └── database/                # MongoDB service providers
│   ├── helpers/
│   │   ├── automationHelper.ts
│   │   ├── easyCronHelper.ts
│   │   └── generalHelper.ts
│   ├── models/                      # Mongoose models (only used ones)
│   ├── middlewares/
│   │   ├── authMiddleware.ts
│   │   └── errorMiddleware.ts
│   └── config/
│       └── app.ts
├── .env.dev
├── .env.prod
├── package.json
└── tsconfig.json
```

---

## 8. Next Steps / Build Approach

**Option A — Extract from existing project (faster)**
1. Copy the `schedulers` project
2. Delete all unused route files listed in Section 6
3. Delete the controllers for those routes (or strip them to only needed methods)
4. Remove unused imports and dead code
5. Audit `package.json` and remove unused npm packages
6. Test all 10 routes end-to-end

**Option B — Build fresh (cleaner)**
1. `npm init` new TypeScript Express project
2. Copy only the 5 route files + 5 controller files
3. Copy `automationHelper.ts`, `generalHelper.ts`, `easyCronHelper.ts`
4. Copy the MongoDB service providers for entities/templates/automations
5. Copy all Mongoose models
6. Wire up Express + MongoDB connection
7. Set env vars from Section 4

> **Recommendation:** Option A is faster for production. Option B gives a cleaner codebase. Given the automation helpers have deep internal dependencies, Option A (strip + clean) will be less error-prone than Option B (rebuild from scratch).

---

## 9. Quick Risk Assessment

| Route | Risk | Reason |
|-------|------|--------|
| `POST /automation` | HIGH | `automationHelper` is a ~3000-line file with deep MongoDB queries, email, webhooks, recursive cascades |
| `POST /automation-rerun/process` | MEDIUM | Reads/writes MongoDB, depends on `automationRerun` model |
| `GET /entity-action-schedules/...` | HIGH | Same as automation — runs scheduled pipelines per entity record |
| `POST /form-builder/automation` | HIGH | Shares most of the cron controller complexity |
| `POST /form-builder/automation/advanced-approvals` | HIGH | Same |
| `POST /bulk-upload-files` | MEDIUM | S3 + MongoDB heavy, but more contained |
| `POST /importMappedEntityData` | MEDIUM | Excel parsing, S3, MongoDB |
| `GET /export/entities-data/zip/:entityId` | LOW | Reads S3, zips, streams |
| `GET /tiny_url/file-download/:file_path` | LOW | AWS S3 pre-signed URL + redirect |
| `POST /micro-service-export-log/...` | LOW | Simple MongoDB write |
