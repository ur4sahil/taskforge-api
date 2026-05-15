// Test DB helpers. Use these from any test that needs Prisma access.
import { PrismaClient } from '@prisma/client';

let _prisma: PrismaClient | null = null;

export function prisma(): PrismaClient {
  if (!_prisma) _prisma = new PrismaClient();
  return _prisma;
}

// Truncate every user-data table in dependency-safe order. Cheap on an empty DB.
// Call this in beforeEach() of any integration test that needs a clean slate.
export async function truncateAll() {
  const p = prisma();
  // CASCADE handles FK constraints in one shot. Order doesn't matter because the
  // CASCADE clause walks every referencing table. Wrapped in a single statement so
  // it's atomic.
  await p.$executeRawUnsafe(`
    TRUNCATE TABLE
      "audit_logs", "notifications", "reminders", "mentions", "comments",
      "checklist_items", "attachments", "task_email_metadata", "task_instances",
      "recurrence_rules", "tasks", "list_members", "lists",
      "saved_views", "templates",
      "message_reactions", "messages", "conversation_members", "conversations",
      "push_subscriptions", "device_tokens",
      "workspace_members", "invitations", "workspaces",
      "refresh_tokens", "users"
    RESTART IDENTITY CASCADE;
  `);
}

export async function disconnect() {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}
