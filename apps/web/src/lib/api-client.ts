import {
  AuthResponseDto,
  MeResponseDto,
  OrganizationDto,
  OrganizationMemberDto,
  DashboardSummaryDto,
  PaginatedResponse,
  ExceptionListItemDto,
  ExceptionDetailDto,
  OrderListItemDto,
  OrderDetailDto,
  RecoveryListItemDto,
  RecoveryDetailDto,
  IntegrationCardDto,
  IntegrationOperationsDetailDto,
  RecoveryCaseStatus,
  RecoveryLevel,
  RecoveryCaseType,
  IntegrationProvider,
  ExternalOrderStatus,
  WorkflowStatus,
} from '@reloop/contracts';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';

// Strict in-memory storage for JWT access token.
// NEVER stored in localStorage, sessionStorage, or IndexedDB.
let inMemoryAccessToken: string | null = null;

export function getAccessToken(): string | null {
  return inMemoryAccessToken;
}

export function setAccessToken(token: string | null): void {
  inMemoryAccessToken = token;
}

let ongoingRefreshPromise: Promise<string | null> | null = null;
const inFlightGetRequests = new Map<string, Promise<unknown>>();

async function executeRefresh(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include', // sends reloop_refresh HttpOnly cookie
    });

    if (!res.ok) {
      setAccessToken(null);
      return null;
    }

    const data: AuthResponseDto = await res.json();
    setAccessToken(data.accessToken);
    return data.accessToken;
  } catch {
    setAccessToken(null);
    return null;
  } finally {
    ongoingRefreshPromise = null;
  }
}

export async function refreshAccessTokenSingleFlight(): Promise<string | null> {
  if (!ongoingRefreshPromise) {
    ongoingRefreshPromise = executeRefresh();
  }
  return ongoingRefreshPromise;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function executeAuthenticatedRequest<T>(
  endpoint: string,
  options: RequestInit = {},
  isRetry = false,
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (inMemoryAccessToken) {
    headers['Authorization'] = `Bearer ${inMemoryAccessToken}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (
    response.status === 401 &&
    !isRetry &&
    !endpoint.includes('/auth/refresh') &&
    !endpoint.includes('/auth/login') &&
    !endpoint.includes('/auth/register')
  ) {
    const newToken = await refreshAccessTokenSingleFlight();
    if (newToken) {
      return executeAuthenticatedRequest<T>(endpoint, options, true);
    }
  }

  if (!response.ok) {
    let errorMessage = `Request failed with status ${response.status}`;
    let errorData: unknown = null;
    try {
      const errorBody = await response.json();
      errorData = errorBody;
      if (Array.isArray(errorBody.message)) {
        errorMessage = errorBody.message.join(', ');
      } else if (errorBody.message) {
        errorMessage = errorBody.message;
      }
    } catch {
      // ignore json parse error
    }
    throw new ApiError(errorMessage, response.status, errorData);
  }

  return response.json() as Promise<T>;
}

/**
 * Shares only simultaneous idempotent reads. This protects React StrictMode,
 * remounts, and multiple consumers from issuing duplicate REST requests while
 * preserving fresh reads after the original request settles.
 */
export function fetchWithAuth<T>(
  endpoint: string,
  options: RequestInit = {},
  isRetry = false,
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET' || isRetry) {
    return executeAuthenticatedRequest<T>(endpoint, options, isRetry);
  }

  const key = `${endpoint}|${JSON.stringify(options.headers || {})}`;
  const existing = inFlightGetRequests.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const request = executeAuthenticatedRequest<T>(endpoint, options)
    .finally(() => inFlightGetRequests.delete(key));
  inFlightGetRequests.set(key, request);
  return request;
}

function buildQueryString<T extends object>(params?: T): string {
  if (!params) return '';
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.append(key, String(value));
    }
  }
  const str = searchParams.toString();
  return str ? `?${str}` : '';
}

export interface ExceptionsQuery {
  page?: number;
  pageSize?: number;
  sortOrder?: 'asc' | 'desc';
  status?: RecoveryCaseStatus;
  recoveryLevel?: RecoveryLevel;
  type?: RecoveryCaseType;
  provider?: IntegrationProvider;
  startDate?: string;
  endDate?: string;
  search?: string;
}

export interface OrdersQuery {
  page?: number;
  pageSize?: number;
  sortOrder?: 'asc' | 'desc';
  status?: ExternalOrderStatus;
  provider?: IntegrationProvider;
  hasException?: boolean;
  search?: string;
}

export interface RecoveriesQuery {
  page?: number;
  pageSize?: number;
  sortOrder?: 'asc' | 'desc';
  status?: WorkflowStatus;
  recoveryLevel?: RecoveryLevel;
  search?: string;
}

export const apiClient = {
  async register(data: {
    name: string;
    email: string;
    password: string;
    organizationName: string;
  }): Promise<AuthResponseDto> {
    const res = await fetchWithAuth<AuthResponseDto>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    setAccessToken(res.accessToken);
    return res;
  },

  async login(data: {
    email: string;
    password: string;
  }): Promise<AuthResponseDto> {
    const res = await fetchWithAuth<AuthResponseDto>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    setAccessToken(res.accessToken);
    return res;
  },

  async refresh(): Promise<AuthResponseDto | null> {
    const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });

    if (!res.ok) {
      setAccessToken(null);
      return null;
    }

    const data: AuthResponseDto = await res.json();
    setAccessToken(data.accessToken);
    return data;
  },

  async logout(): Promise<void> {
    try {
      await fetch(`${API_BASE_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
    } finally {
      setAccessToken(null);
    }
  },

  async logoutAll(): Promise<void> {
    try {
      await fetchWithAuth<{ success: boolean }>('/auth/logout-all', {
        method: 'POST',
      });
    } finally {
      setAccessToken(null);
    }
  },

  async getMe(): Promise<MeResponseDto> {
    return fetchWithAuth<MeResponseDto>('/auth/me');
  },

  async getCurrentOrganization(): Promise<OrganizationDto> {
    return fetchWithAuth<OrganizationDto>('/organizations/current');
  },

  async updateCurrentOrganization(data: { name?: string }): Promise<OrganizationDto> {
    return fetchWithAuth<OrganizationDto>('/organizations/current', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  async getOrganizationMembers(): Promise<OrganizationMemberDto[]> {
    return fetchWithAuth<OrganizationMemberDto[]>('/organizations/current/members');
  },

  // ==========================================
  // Operations & Reliability Read API
  // ==========================================

  async getDashboardSummary(): Promise<DashboardSummaryDto> {
    return fetchWithAuth<DashboardSummaryDto>('/dashboard/summary');
  },

  async getExceptions(query?: ExceptionsQuery): Promise<PaginatedResponse<ExceptionListItemDto>> {
    return fetchWithAuth<PaginatedResponse<ExceptionListItemDto>>(`/exceptions${buildQueryString(query)}`);
  },

  async getExceptionDetail(id: string): Promise<ExceptionDetailDto> {
    return fetchWithAuth<ExceptionDetailDto>(`/exceptions/${encodeURIComponent(id)}`);
  },

  async getOrders(query?: OrdersQuery): Promise<PaginatedResponse<OrderListItemDto>> {
    return fetchWithAuth<PaginatedResponse<OrderListItemDto>>(`/orders${buildQueryString(query)}`);
  },

  async getOrderDetail(id: string): Promise<OrderDetailDto> {
    return fetchWithAuth<OrderDetailDto>(`/orders/${encodeURIComponent(id)}`);
  },

  async getRecoveries(query?: RecoveriesQuery): Promise<PaginatedResponse<RecoveryListItemDto>> {
    return fetchWithAuth<PaginatedResponse<RecoveryListItemDto>>(`/recoveries${buildQueryString(query)}`);
  },

  async getRecoveryDetail(id: string): Promise<RecoveryDetailDto> {
    return fetchWithAuth<RecoveryDetailDto>(`/recoveries/${encodeURIComponent(id)}`);
  },

  async getIntegrations(): Promise<IntegrationCardDto[]> {
    return fetchWithAuth<IntegrationCardDto[]>('/integrations');
  },

  async getIntegrationDetail(id: string): Promise<IntegrationOperationsDetailDto> {
    return fetchWithAuth<IntegrationOperationsDetailDto>(`/integrations/${encodeURIComponent(id)}`);
  },

  // ==========================================
  // Approvals Actions (Day 11 API)
  // ==========================================

  async approveApproval(
    id: string,
    note?: string,
  ): Promise<{ success?: boolean; message?: string; [key: string]: unknown }> {
    return fetchWithAuth<{ success?: boolean; message?: string; [key: string]: unknown }>(
      `/approvals/${encodeURIComponent(id)}/approve`,
      {
        method: 'POST',
        body: JSON.stringify({ note: note || undefined }),
      },
    );
  },

  async rejectApproval(
    id: string,
    reason: string,
  ): Promise<{ success?: boolean; message?: string; [key: string]: unknown }> {
    return fetchWithAuth<{ success?: boolean; message?: string; [key: string]: unknown }>(
      `/approvals/${encodeURIComponent(id)}/reject`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
    );
  },

  // ==========================================
  // Integration Connection Actions (Day 15/16 API)
  // ==========================================

  async connectShopify(
    shop: string,
  ): Promise<{ authorizationUrl: string; state: string; shopDomain: string }> {
    return fetchWithAuth<{ authorizationUrl: string; state: string; shopDomain: string }>(
      '/integrations/shopify/connect',
      {
        method: 'POST',
        body: JSON.stringify({ shop }),
      },
    );
  },

  async connectShipStation(
    apiKey: string,
  ): Promise<{ success: boolean; integrationId: string; totalShipments: number }> {
    return fetchWithAuth<{ success: boolean; integrationId: string; totalShipments: number }>(
      '/integrations/shipstation/connect',
      {
        method: 'POST',
        body: JSON.stringify({ apiKey }),
      },
    );
  },

  async replaceShipStationCredentials(
    id: string,
    apiKey: string,
  ): Promise<{ success: boolean; integrationId: string; totalShipments: number }> {
    return fetchWithAuth<{ success: boolean; integrationId: string; totalShipments: number }>(
      `/integrations/shipstation/${encodeURIComponent(id)}/credentials/replace`,
      {
        method: 'POST',
        body: JSON.stringify({ apiKey }),
      },
    );
  },

  async disconnectIntegration(
    id: string,
  ): Promise<{ success: boolean; message: string; integrationId: string }> {
    return fetchWithAuth<{ success: boolean; message: string; integrationId: string }>(
      `/integrations/${encodeURIComponent(id)}/disconnect`,
      {
        method: 'POST',
      },
    );
  },
};
