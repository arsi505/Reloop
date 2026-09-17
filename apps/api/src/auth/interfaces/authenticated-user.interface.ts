import { Role } from '@reloop/database';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  organizationId: string;
  sessionId: string;
  role: Role;
}
