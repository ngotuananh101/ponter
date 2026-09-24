export type SessionStatus =
  'pending' | 'awaiting_approval' | 'active' | 'terminated' | 'expired';

export interface Session {
  id: string;
  userId: string;
  deviceId: string | null;
  agentId: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  expiresAt: string | null;
  metadata?: Record<string, unknown>;
}
