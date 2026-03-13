export function getTaskPermissions(c: any) {
  const isAdmin = c.memberRole === 'admin';
  const isCreator = c.taskCreatorId === c.memberId;
  const isAssignee = c.taskAssigneeId === c.memberId;
  const isMgrOfAssignee = c.memberRole === 'manager' && c.taskAssigneeManagerId === c.memberId;

  let canFullEdit = false;
  let canDelete = false;

  if (c.taskIsLocked && !isAdmin) {
    canFullEdit = false;
    canDelete = false;
  } else if (isAdmin) {
    canFullEdit = true;
    canDelete = true;
  } else if (isCreator) {
    canFullEdit = true;
    canDelete = true;
  } else if (isMgrOfAssignee && c.taskCreatorRole !== 'admin') {
    canFullEdit = true;
  }

  return {
    canView: true,
    canChangeStatus: isAdmin || isCreator || isAssignee || isMgrOfAssignee,
    canComment: true,
    canToggleChecklist: isAdmin || isCreator || isAssignee || isMgrOfAssignee,
    canAttach: isAdmin || isCreator || isAssignee || isMgrOfAssignee,
    canFullEdit,
    canDelete,
    canUnassignSelf: isAdmin || (isAssignee && c.taskCreatorRole !== 'admin'),
    canLock: isAdmin,
  };
}
