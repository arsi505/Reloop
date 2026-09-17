export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface ComponentHealth {
  status: HealthStatus;
  latencyMs?: number;
  message?: string;
}

export interface ServiceHealth {
  status: HealthStatus;
  service: string;
  version: string;
  timestamp: string;
  components: {
    database: ComponentHealth;
    redis: ComponentHealth;
  };
}

export type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

export interface UserDto {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface OrganizationMemberDto {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface AuthResponseDto {
  user: UserDto;
  organization: OrganizationDto;
  role: Role;
  accessToken: string;
}

export interface MeResponseDto {
  user: UserDto;
  organization: OrganizationDto;
  role: Role;
}