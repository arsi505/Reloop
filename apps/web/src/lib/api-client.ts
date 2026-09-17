import {
  AuthResponseDto,
  MeResponseDto,
  OrganizationDto,
  OrganizationMemberDto,
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

export async function fetchWithAuth<T>(
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

  if (response.status === 401 && !isRetry && !endpoint.includes('/auth/refresh') && !endpoint.includes('/auth/login') && !endpoint.includes('/auth/register')) {
    const newToken = await refreshAccessTokenSingleFlight();
    if (newToken) {
      return fetchWithAuth<T>(endpoint, options, true);
    }
  }

  if (!response.ok) {
    let errorMessage = `Request failed with status ${response.status}`;
    try {
      const errorBody = await response.json();
      if (Array.isArray(errorBody.message)) {
        errorMessage = errorBody.message.join(', ');
      } else if (errorBody.message) {
        errorMessage = errorBody.message;
      }
    } catch {
      // ignore json parse error
    }
    throw new Error(errorMessage);
  }

  return response.json() as Promise<T>;
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
};