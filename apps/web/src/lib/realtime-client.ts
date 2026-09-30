import { io, Socket } from 'socket.io-client';
import { RealtimeNotification, RealtimeConnectionStatus } from '@reloop/contracts';
import { getAccessToken, refreshAccessTokenSingleFlight } from './api-client';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';

export type RealtimeEventHandler = (notification: RealtimeNotification) => void;
export type ConnectionStatusHandler = (status: RealtimeConnectionStatus) => void;

class RealtimeClient {
  private socket: Socket | null = null;
  private status: RealtimeConnectionStatus = 'DISCONNECTED';
  private eventHandlers = new Set<RealtimeEventHandler>();
  private statusHandlers = new Set<ConnectionStatusHandler>();
  private reconnectAttempts = 0;
  private hasPendingInvalidationWhileHidden = false;
  private authRecoveryPromise: Promise<void> | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.hasPendingInvalidationWhileHidden) {
          this.hasPendingInvalidationWhileHidden = false;
          // Trigger a generic dashboard/view invalidation on foreground
          this.notifyHandlers({
            organizationId: '',
            eventType: 'dashboard.changed',
            changedAt: new Date().toISOString(),
          });
        }
      });
    }
  }

  public getStatus(): RealtimeConnectionStatus {
    return this.status;
  }

  public connect(forceReconnect = false): void {
    if (typeof window === 'undefined') return;

    const token = getAccessToken();
    if (!token) {
      this.disconnect();
      return;
    }

    // A Socket.IO instance owns its own handshake/reconnect lifecycle. Recreating
    // it while it is connecting causes disconnect/reconnect churn and duplicate
    // auth traffic under React remounts.
    if (this.socket && !forceReconnect) {
      return;
    }

    // Clean up any stale socket
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }

    this.setStatus('RECONNECTING');

    // Sockets authenticate via handshake auth callback, NEVER URL query parameters
    this.socket = io(API_BASE_URL, {
      path: '/socket.io',
      auth: (cb) => {
        cb({ token: getAccessToken() });
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      randomizationFactor: 0.3,
    });

    this.socket.on('connect', () => {
      this.reconnectAttempts = 0;
      this.setStatus('CONNECTED');
    });

    this.socket.on('connected', () => {
      this.setStatus('CONNECTED');
    });

    this.socket.on('disconnect', (reason) => {
      if (reason === 'io client disconnect') {
        this.setStatus('DISCONNECTED');
      } else {
        this.setStatus('RECONNECTING');
      }
    });

    this.socket.on('connect_error', () => {
      this.reconnectAttempts++;
      this.setStatus('RECONNECTING');
    });

    this.socket.on('auth:expired', () => this.recoverSocketAuthentication());
    this.socket.on('auth_error', () => this.recoverSocketAuthentication());

    // Handle incoming typed operational invalidation event
    this.socket.on('realtime:event', (notification: RealtimeNotification) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        this.hasPendingInvalidationWhileHidden = true;
      }
      this.notifyHandlers(notification);
    });
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.setStatus('DISCONNECTED');
  }

  private recoverSocketAuthentication(): void {
    if (this.authRecoveryPromise) return;

    this.authRecoveryPromise = (async () => {
      this.setStatus('RECONNECTING');
      const refreshedToken = await refreshAccessTokenSingleFlight();
      if (refreshedToken) {
        this.connect(true);
      } else {
        this.disconnect();
      }
    })().finally(() => {
      this.authRecoveryPromise = null;
    });
  }

  public subscribe(handler: RealtimeEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  public onStatusChange(handler: ConnectionStatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  private setStatus(newStatus: RealtimeConnectionStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      for (const handler of this.statusHandlers) {
        try {
          handler(newStatus);
        } catch (err) {
          console.error('[RealtimeClient] Status handler error:', err);
        }
      }
    }
  }

  private notifyHandlers(notification: RealtimeNotification): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(notification);
      } catch (err) {
        console.error('[RealtimeClient] Notification handler error:', err);
      }
    }
  }
}

export const realtimeClient = new RealtimeClient();
