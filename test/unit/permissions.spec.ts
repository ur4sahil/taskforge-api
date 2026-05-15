import { getTaskPermissions } from '../../src/common/utils/permissions';

// Convenience builder so each test reads as a single object literal of relevant overrides.
const ctx = (overrides: Partial<Record<string, any>> = {}) => ({
  memberId: 'm1',
  memberRole: 'employee',
  taskCreatorId: 'm2',
  taskCreatorRole: 'employee',
  taskAssigneeId: 'm3',
  taskAssigneeManagerId: 'm4',
  taskIsLocked: false,
  ...overrides,
});

describe('getTaskPermissions — admin role', () => {
  it('admin can full-edit, delete, change status, lock and toggle checklist on an unlocked task', () => {
    const p = getTaskPermissions(ctx({ memberRole: 'admin' }));
    expect(p).toEqual({
      canView: true,
      canChangeStatus: true,
      canComment: true,
      canToggleChecklist: true,
      canAttach: true,
      canFullEdit: true,
      canDelete: true,
      canUnassignSelf: true,
      canLock: true,
    });
  });

  it('admin retains full-edit and delete even when the task is locked', () => {
    const p = getTaskPermissions(ctx({ memberRole: 'admin', taskIsLocked: true }));
    expect(p.canFullEdit).toBe(true);
    expect(p.canDelete).toBe(true);
    expect(p.canLock).toBe(true);
  });

  it('admin can unassign self regardless of task creator role', () => {
    const p = getTaskPermissions(
      ctx({ memberRole: 'admin', taskCreatorRole: 'admin', taskAssigneeId: 'someone-else' }),
    );
    expect(p.canUnassignSelf).toBe(true);
  });
});

describe('getTaskPermissions — creator (non-admin)', () => {
  it('creator who is an employee can full-edit and delete their own task', () => {
    const p = getTaskPermissions(ctx({ memberId: 'm1', taskCreatorId: 'm1' }));
    expect(p.canFullEdit).toBe(true);
    expect(p.canDelete).toBe(true);
    expect(p.canChangeStatus).toBe(true);
    expect(p.canLock).toBe(false);
  });

  it('creator loses full-edit and delete when the task is locked', () => {
    const p = getTaskPermissions(
      ctx({ memberId: 'm1', taskCreatorId: 'm1', taskIsLocked: true }),
    );
    expect(p.canFullEdit).toBe(false);
    expect(p.canDelete).toBe(false);
    // but canChangeStatus is derived from role/relationship, not from the locked flag
    expect(p.canChangeStatus).toBe(true);
  });
});

describe('getTaskPermissions — assignee (non-creator, non-manager)', () => {
  it('assignee can change status, toggle checklist, and attach but cannot full-edit or delete', () => {
    const p = getTaskPermissions(ctx({ memberId: 'm1', taskAssigneeId: 'm1' }));
    expect(p.canChangeStatus).toBe(true);
    expect(p.canToggleChecklist).toBe(true);
    expect(p.canAttach).toBe(true);
    expect(p.canFullEdit).toBe(false);
    expect(p.canDelete).toBe(false);
  });

  it('assignee can unassign self when the task was NOT created by an admin', () => {
    const p = getTaskPermissions(
      ctx({ memberId: 'm1', taskAssigneeId: 'm1', taskCreatorRole: 'employee' }),
    );
    expect(p.canUnassignSelf).toBe(true);
  });

  it('assignee cannot unassign self when the task was created by an admin', () => {
    const p = getTaskPermissions(
      ctx({ memberId: 'm1', taskAssigneeId: 'm1', taskCreatorRole: 'admin' }),
    );
    expect(p.canUnassignSelf).toBe(false);
  });
});

describe('getTaskPermissions — manager of assignee', () => {
  it('manager of the assignee can full-edit but cannot delete', () => {
    const p = getTaskPermissions(
      ctx({
        memberId: 'mgr1',
        memberRole: 'manager',
        taskAssigneeManagerId: 'mgr1',
        taskCreatorRole: 'employee',
      }),
    );
    expect(p.canFullEdit).toBe(true);
    expect(p.canDelete).toBe(false);
    expect(p.canChangeStatus).toBe(true);
    expect(p.canToggleChecklist).toBe(true);
  });

  it('manager of the assignee cannot full-edit when the creator is an admin', () => {
    const p = getTaskPermissions(
      ctx({
        memberId: 'mgr1',
        memberRole: 'manager',
        taskAssigneeManagerId: 'mgr1',
        taskCreatorRole: 'admin',
      }),
    );
    expect(p.canFullEdit).toBe(false);
    // but they can still change status, toggle checklist, attach
    expect(p.canChangeStatus).toBe(true);
    expect(p.canToggleChecklist).toBe(true);
    expect(p.canAttach).toBe(true);
  });

  it('manager of the assignee loses full-edit when the task is locked', () => {
    const p = getTaskPermissions(
      ctx({
        memberId: 'mgr1',
        memberRole: 'manager',
        taskAssigneeManagerId: 'mgr1',
        taskCreatorRole: 'employee',
        taskIsLocked: true,
      }),
    );
    expect(p.canFullEdit).toBe(false);
    expect(p.canDelete).toBe(false);
  });

  it('a manager who is NOT the assignee\'s manager has no elevated permissions', () => {
    const p = getTaskPermissions(
      ctx({
        memberId: 'mgrX',
        memberRole: 'manager',
        taskAssigneeManagerId: 'someone-else',
      }),
    );
    expect(p.canFullEdit).toBe(false);
    expect(p.canDelete).toBe(false);
    expect(p.canChangeStatus).toBe(false);
    expect(p.canToggleChecklist).toBe(false);
    expect(p.canAttach).toBe(false);
  });
});

describe('getTaskPermissions — uninvolved employee', () => {
  it('an uninvolved employee can only view and comment', () => {
    const p = getTaskPermissions(ctx());
    expect(p).toEqual({
      canView: true,
      canChangeStatus: false,
      canComment: true,
      canToggleChecklist: false,
      canAttach: false,
      canFullEdit: false,
      canDelete: false,
      canUnassignSelf: false,
      canLock: false,
    });
  });
});

describe('getTaskPermissions — lock semantics', () => {
  it('only admins can lock or unlock tasks (canLock)', () => {
    expect(getTaskPermissions(ctx({ memberRole: 'admin' })).canLock).toBe(true);
    expect(getTaskPermissions(ctx({ memberRole: 'manager' })).canLock).toBe(false);
    expect(getTaskPermissions(ctx({ memberRole: 'employee' })).canLock).toBe(false);
  });

  it('canView and canComment are always true regardless of role or lock state', () => {
    const p1 = getTaskPermissions(ctx({ taskIsLocked: true }));
    const p2 = getTaskPermissions(ctx({ memberRole: 'employee' }));
    expect(p1.canView).toBe(true);
    expect(p1.canComment).toBe(true);
    expect(p2.canView).toBe(true);
    expect(p2.canComment).toBe(true);
  });
});

describe('getTaskPermissions — creator + assignee combined', () => {
  it('a member who is both creator and assignee gets creator-level full-edit and delete', () => {
    const p = getTaskPermissions(
      ctx({ memberId: 'm1', taskCreatorId: 'm1', taskAssigneeId: 'm1' }),
    );
    expect(p.canFullEdit).toBe(true);
    expect(p.canDelete).toBe(true);
    expect(p.canChangeStatus).toBe(true);
    expect(p.canUnassignSelf).toBe(true);
  });
});
