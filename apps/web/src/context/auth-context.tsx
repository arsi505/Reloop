'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  UserDto,
  OrganizationDto,
  Role,
} from '@reloop/contracts';
import { apiClient, setAccessToken } from '../lib/api-client';

interface AuthContextType {
  user: UserDto | null;
  organization: OrganizationDto | null;
  role: Role | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (data: { email: string; password: string }) => Promise<void>;
  register: (data: {
    name: string;
    email: string;
    password: string;
    organizationName: string;
  }) => Promise<void>;
  refreshSession: () => Promise<boolean>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  setOrganization: (org: OrganizationDto) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [organization, setOrganization] = useState<OrganizationDto | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const router = useRouter();

  const refreshSession = useCallback(async (): Promise<boolean> => {
    try {
      const res = await apiClient.refresh();
      if (res) {
        setUser(res.user);
        setOrganization(res.organization);
        setRole(res.role);
        return true;
      } else {
        setUser(null);
        setOrganization(null);
        setRole(null);
        return false;
      }
    } catch {
      setUser(null);
      setOrganization(null);
      setRole(null);
      return false;
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    (async () => {
      await refreshSession();
      if (isMounted) {
        setIsLoading(false);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [refreshSession]);

  const login = async (data: { email: string; password: string }) => {
    const res = await apiClient.login(data);
    setUser(res.user);
    setOrganization(res.organization);
    setRole(res.role);
    router.push('/app');
  };

  const register = async (data: {
    name: string;
    email: string;
    password: string;
    organizationName: string;
  }) => {
    const res = await apiClient.register(data);
    setUser(res.user);
    setOrganization(res.organization);
    setRole(res.role);
    router.push('/app');
  };

  const logout = async () => {
    await apiClient.logout();
    setUser(null);
    setOrganization(null);
    setRole(null);
    setAccessToken(null);
    router.push('/login');
  };

  const logoutAll = async () => {
    await apiClient.logoutAll();
    setUser(null);
    setOrganization(null);
    setRole(null);
    setAccessToken(null);
    router.push('/login');
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        organization,
        role,
        isLoading,
        isAuthenticated: !!user,
        login,
        register,
        refreshSession,
        logout,
        logoutAll,
        setOrganization,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}