'use client';

import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { RealtimeConnectionStatus, RealtimeEventType, RealtimeNotification } from '@reloop/contracts';
import { realtimeClient } from '../lib/realtime-client';
import { useAuth } from './auth-context';

interface RealtimeContextValue {
  connectionStatus: RealtimeConnectionStatus;
}

const RealtimeContext = createContext<RealtimeContextValue>({
  connectionStatus: 'DISCONNECTED',
});

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [connectionStatus, setConnectionStatus] = useState<RealtimeConnectionStatus>('DISCONNECTED');

  useEffect(() => {
    const unsubscribeStatus = realtimeClient.onStatusChange((status) => {
      setConnectionStatus(status);
    });

    if (user) {
      realtimeClient.connect();
    } else {
      realtimeClient.disconnect();
    }

    return () => {
      unsubscribeStatus();
    };
  }, [user]);

  return (
    <RealtimeContext.Provider value={{ connectionStatus }}>
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtimeStatus(): RealtimeConnectionStatus {
  const context = useContext(RealtimeContext);
  return context.connectionStatus;
}

/**
 * Hook to subscribe to realtime invalidation events with coalescing/debouncing.
 * Safe against rapid burst events (e.g. 10 webhooks in 200ms -> single refetch).
 */
export function useRealtimeEvent(
  eventTypes: RealtimeEventType | RealtimeEventType[],
  callback: (event: RealtimeNotification) => void,
  coalesceMs = 300,
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingEventRef = useRef<RealtimeNotification | null>(null);

  const eventTypesKey = Array.isArray(eventTypes) ? eventTypes.join(',') : eventTypes;

  useEffect(() => {
    const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];

    const unsubscribe = realtimeClient.subscribe((notification) => {
      if (types.includes(notification.eventType)) {
        pendingEventRef.current = notification;
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
          if (pendingEventRef.current) {
            callbackRef.current(pendingEventRef.current);
            pendingEventRef.current = null;
          }
        }, coalesceMs);
      }
    });

    return () => {
      unsubscribe();
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [eventTypesKey, coalesceMs]);
}
