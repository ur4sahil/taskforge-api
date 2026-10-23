// List visibility — the single rule every task read must go through.
//
//   admin    → every list in the workspace
//   manager  → lists that contain the manager or one of their direct reports
//   employee → lists they are a member of
//
// Used by TasksService (findAll / create / move), SearchService and AiService so
// a non-admin can never see, search or feed the AI a task from a list they
// cannot open. Keep the rule here; do not re-implement it per module.

type PrismaLike = {
  list: { findMany: (args: any) => Promise<any[]> };
  listMember: { findMany: (args: any) => Promise<any[]> };
  workspaceMember: { findMany: (args: any) => Promise<any[]> };
};

export async function getAccessibleListIds(prisma: PrismaLike, wid: string, member: { id: string; role: string }): Promise<string[]> {
  if (member.role === 'admin') {
    return (await prisma.list.findMany({ where: { workspaceId: wid }, select: { id: true } })).map((l: any) => l.id);
  }
  if (member.role === 'manager') {
    const rids = (await prisma.workspaceMember.findMany({ where: { managerId: member.id, workspaceId: wid }, select: { id: true } })).map((r: any) => r.id);
    return (await prisma.list.findMany({
      where: { workspaceId: wid, OR: [{ members: { some: { workspaceMemberId: member.id } } }, { members: { some: { workspaceMemberId: { in: rids } } } }] },
      select: { id: true },
    })).map((l: any) => l.id);
  }
  // Scoped to this workspace's lists: a member id is per-workspace already, but
  // the join keeps a stale/foreign row from ever widening the result.
  return (await prisma.listMember.findMany({ where: { workspaceMemberId: member.id, list: { workspaceId: wid } }, select: { listId: true } })).map((l: any) => l.listId);
}

/** Prisma `where` fragment restricting tasks to lists the member may see.
 *  Admins get no restriction (empty fragment). */
export async function listScope(prisma: PrismaLike, wid: string, member: { id: string; role: string }): Promise<{ listId?: { in: string[] } }> {
  if (member.role === 'admin') return {};
  return { listId: { in: await getAccessibleListIds(prisma, wid, member) } };
}
