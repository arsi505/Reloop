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
