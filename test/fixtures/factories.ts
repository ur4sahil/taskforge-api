// Test data factories. Each factory inserts directly via Prisma — bypasses the
// API layer so we can set up a known starting state in a single statement,
// without worrying about signup throttling or auth headers.
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { prisma } from './db';

let counter = 0;
function uniq(prefix = 'u') { counter += 1; return `${prefix}-${Date.now()}-${counter}`; }

export async function createUser(opts: { email?: string; name?: string; password?: string } = {}) {
  const email = opts.email || `${uniq('user')}@test.local`;
  const password = opts.password || 'TestPass123!';
  const passwordHash = await bcrypt.hash(password, 4); // low rounds for speed
  const user = await prisma().user.create({
    data: {
      email,
      passwordHash,
      name: opts.name || 'Test User',
      authProvider: 'email',
      isActive: true,
    },
  });
  return { user, password };
}

export async function createWorkspace(opts: { name?: string; ownerUserId: string; ownerRole?: 'admin' | 'manager' | 'employee' } = {} as any) {
  const name = opts.name || `WS ${uniq('ws')}`;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const workspace = await prisma().workspace.create({
    data: {
      name,
      slug,
      settings: { autoArchiveDays: 30, trashRetentionDays: 30 },
    },
  });
  const member = await prisma().workspaceMember.create({
    data: {
      workspaceId: workspace.id,
      userId: opts.ownerUserId,
      role: opts.ownerRole || 'admin',
      isActive: true,
    },
  });
  return { workspace, member };
}

export async function addMember(workspaceId: string, userId: string, role: 'admin' | 'manager' | 'employee' = 'employee', managerId?: string) {
  return prisma().workspaceMember.create({
    data: { workspaceId, userId, role, managerId, isActive: true },
  });
}

export async function createList(opts: { workspaceId: string; createdById: string; name?: string; inboundEmailEnabled?: boolean }) {
  return prisma().list.create({
    data: {
      workspaceId: opts.workspaceId,
      createdById: opts.createdById,
      name: opts.name || `List ${uniq('list')}`,
      inboundEmail: opts.inboundEmailEnabled ? `${randomUUID()}@inbound.test.local` : null,
      inboundEmailEnabled: !!opts.inboundEmailEnabled,
    },
  });
}

export async function createTask(opts: {
  workspaceId: string;
  listId: string;
  creatorId: string;
  assigneeId?: string | null;
  title?: string;
  status?: string;
  priority?: string;
  dueDate?: Date;
}) {
  return prisma().task.create({
    data: {
      workspaceId: opts.workspaceId,
      listId: opts.listId,
      creatorId: opts.creatorId,
      assigneeId: opts.assigneeId ?? null,
      title: opts.title || `Task ${uniq('task')}`,
      status: (opts.status || 'todo') as any,
      priority: (opts.priority || 'medium') as any,
      dueDate: opts.dueDate || null,
    },
  });
}

// Convenience: complete admin workspace with one list. Returns ids + a workspace
// member that can act as the "current user" in tests.
export async function seedWorkspace(opts: { role?: 'admin' | 'manager' | 'employee' } = {}) {
  const { user } = await createUser();
  const { workspace, member } = await createWorkspace({ ownerUserId: user.id, ownerRole: opts.role });
  const list = await createList({ workspaceId: workspace.id, createdById: member.id });
  return { user, workspace, member, list };
}
