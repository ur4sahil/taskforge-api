declare namespace Express { interface Request { workspaceMember?: any; workspace?: any; __auditData?: { action: string; entityType: string; entityId: string; changes: Record<string, unknown> }; } }
