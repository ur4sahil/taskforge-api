# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

TaskForge API — multi-workspace task management SaaS backend. The frontend lives separately in `../web` (Next.js).

- **Framework:** NestJS 10 with TypeScript
- **ORM:** Prisma (PostgreSQL)
- **Auth:** JWT access tokens (15m) + hashed refresh tokens (7d), bcrypt passwords, Google OAuth support
- **Job queues:** BullMQ with Redis (recurring tasks, reminders, overdue checks, auto-archive, trash cleanup)
- **API docs:** Swagger at `/api/docs` (dev only)
- **Process manager:** PM2 (`ecosystem.config.js`)

## Commands

```bash
npm run build                    # Compile TS → dist/
npm start                        # Run compiled dist/main.js
npm run prisma:generate          # Regenerate Prisma client after schema changes
npm run prisma:migrate:prod      # Apply pending migrations (prisma migrate deploy)
npm run prisma:seed              # Seed database (ts-node prisma/seed.ts)
```

No dev watch mode, linter, or test runner is configured. For local dev, rebuild and restart manually or use `ts-node src/main.ts`.

## External Dependencies

- **PostgreSQL** — `DATABASE_URL` and `DIRECT_URL` env vars
- **Redis** — `REDIS_URL` env var (default `redis://localhost:6379`), required for BullMQ job queues
- Frontend expects this API at port 3001 (`PORT` env var)

## Key Conventions

### Compact Module Pattern

Each feature is a **single file** containing the service, controller, and module all in one (e.g., `src/modules/tasks/tasks.module.ts`). DTOs are in a separate `dto/index.ts` within the module folder.

### API Response Envelope

All responses use `successResponse(data, meta?)` from `src/common/dto/response.dto.ts`:
```json
{ "success": true, "data": {...}, "meta": {...} }
```
Errors use: `{ "success": false, "error": { "code": 500, "message": "..." } }`

### Route Structure

Global prefix: `/api/v1`. All workspace-scoped routes use:
```
/api/v1/workspaces/:wid/...
```
Auth routes (`/api/v1/auth/*`) are marked `@Public()` to bypass JWT guard.

### Guards & Decorators

- **`JwtAuthGuard`** — global (APP_GUARD), skip with `@Public()` decorator
- **`WorkspaceGuard`** — per-controller, validates workspace membership and attaches `req.workspaceMember` with `{ id, userId, workspaceId, role, managerId, timezone }`
- **`RolesGuard`** + `@Roles('admin')` — hierarchical: admin (3) > manager (2) > employee (1)
- **`@CurrentUser()`** — extracts JWT payload (`userId`, `email`, `name`)
- **`@CurrentMember()`** — extracts workspace member from `req.workspaceMember`
- **`ThrottlerGuard`** — global, 100 req/min

### Audit Logging

`AuditLogInterceptor` auto-logs non-GET requests. Controllers set `req.__auditData = { action, entityType, entityId, changes }` after the operation succeeds.

### Task Permissions

`src/common/utils/permissions.ts` — `getTaskPermissions()` computes granular permissions (canFullEdit, canDelete, canChangeStatus, canLock, etc.) based on role, creator, assignee, and manager relationships. Locked tasks block non-admin edits.

### Soft Delete

Tasks use `deletedAt` for soft delete. The `trash-cleanup` worker permanently deletes after configurable retention (default 30 days). Completed tasks auto-archive after 30 days.

### List Access Control

- **Admin:** sees all lists
- **Manager:** sees lists containing self or direct reports
- **Employee:** sees only lists they're a member of

## Prisma Schema

Located at `prisma/schema.prisma`. Key models: User, Workspace, WorkspaceMember, List, ListMember, Task (with subtasks via self-relation), ChecklistItem, Comment, Mention, Attachment, RecurrenceRule, TaskInstance, Reminder, Notification, Template, SavedView, AuditLog.

All models use `@@map("snake_case_table")` for table names and `@map("snake_case")` for column names. UUIDs everywhere.

## Environment Variables

**Required:** `DATABASE_URL`, `DIRECT_URL`, `REDIS_URL`, `PORT`, `APP_URL`, `API_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `INBOUND_EMAIL_DOMAIN`

**Optional but gated:**
- `ANTHROPIC_API_KEY` — AI chat returns a graceful fallback message when missing.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` — Google OAuth strategy is registered via a factory provider that returns `null` when client ID/secret are missing, so boot doesn't fail. The route still mounts but throws `UnauthorizedException` if hit without config.
- `R2_BUCKET_NAME`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — required for attachment uploads. `R2_PUBLIC_URL` is optional (if set, downloads return a direct public URL; otherwise presigned URLs are returned). `R2_URL_TTL` defaults to 3600s.

## BullMQ Workers

Defined in `src/workers/workers.module.ts`. The `WorkerScheduler` (also in that file) runs `onApplicationBootstrap` and enqueues 5 repeatable jobs:
- `recurring-tasks` — every hour; generates task instances from recurrence rules with `nextOccurrence <= now + 7d`.
- `reminders` — every minute; fires pending reminders whose `nextFireTime` or `snoozedUntil` has passed.
- `overdue-check` — every 15 minutes; logs overdue tasks (currently log-only, ready to notify).
- `auto-archive` — daily at 03:00 UTC; sets `archivedAt` on done tasks older than per-workspace `settings.autoArchiveDays` (default 30).
- `trash-cleanup` — daily at 04:00 UTC; hard-deletes tasks with `deletedAt` older than per-workspace `settings.trashRetentionDays` (default 30).

The scheduler is **idempotent** — on each boot it removes any existing repeatable jobs with the same name before adding fresh ones, so changing the cron pattern in code applies on next deploy. `jobId` is implicit (BullMQ generates one from name + pattern), and the queue is shared across replicas via Redis.

## File Storage (R2)

`src/common/utils/r2-storage.ts` exports `R2StorageService`, a NestJS-injectable wrapper around the AWS SDK v3 S3 client pointed at Cloudflare R2's S3-compatible endpoint. It's registered as a provider in `attachments.module.ts`. Methods: `upload(key, buffer, mimeType)`, `getDownloadUrl(key, fileName)` (returns public URL if `R2_PUBLIC_URL` is set, else a presigned URL valid for `R2_URL_TTL` seconds), `delete(key)`. When R2 credentials are missing, `upload` throws `InternalServerErrorException` so the failure is visible at the API boundary (not silently dropped).

## Auth

- **Email**: `/auth/signup`, `/auth/login`, `/auth/refresh`, `/auth/logout`. Bcrypt + 15-minute JWT access + 7-day hashed refresh tokens.
- **Google OAuth**: `/auth/google` initiates, `/auth/google/callback` calls `AuthService.loginWithGoogle()` which creates-or-links a user by email, then redirects to `${APP_URL}/auth/callback#data=<base64url(json)>`. The frontend's `/auth/callback` page decodes and calls `useAuthStore.setSession()`.

## Mention Parsing

`comments.service.create()` runs `processMentions()` after inserting a comment. The regex matches `@email@domain.tld` patterns, resolves them to `WorkspaceMember`s by email (active members only), and in a single transaction inserts `Mention` rows + `notification` rows of type `mention` for each target (excluding the author).
