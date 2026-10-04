export type DeviceType = 'desktop' | 'mobile' | 'web';

export type UserRole = 'admin' | 'user';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface User {
  id: string;
  username: string;
  email: string | null;
  publicKey: string;
  role: UserRole;
  approvalStatus: ApprovalStatus;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  metadata?: Record<string, unknown>;
}

export interface SystemStats {
  users: {
    total: number;
    approved: number;
    pending: number;
    rejected: number;
    admins: number;
  };
  agents: {
    total: number;
    online: number;
    byPlatform: Record<string, number>;
  };
  sessions: {
    active: number;
    byKind: { terminal: number; desktop: number };
  };
}

export interface SystemSettings {
  allowRegistration: boolean;
  autoApproveUsers: boolean;
  maxAgentsPerUser: number;
}

export interface Device {
  id: string;
  userId: string;
  deviceName: string | null;
  deviceType: DeviceType;
  fingerprint: string;
  platform: string | null;
  browser: string | null;
  ipAddress: string | null;
  approvedAt: string | null;
  lastSeenAt: string | null;
  isTrusted: boolean;
  createdAt: string;
}

export interface Agent {
  id: string;
  userId: string;
  hostname: string | null;
  platform: string | null;
  osVersion: string | null;
  agentVersion: string | null;
  publicKey: string;
  isOnline: boolean;
  lastHeartbeat: string | null;
  capabilities: string[];
  createdAt: string;
}
