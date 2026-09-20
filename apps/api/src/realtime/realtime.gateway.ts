import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { RealtimeNotification } from '@reloop/contracts';

/**
 * RealtimeGateway
 *
 * Authenticated, tenant-isolated Socket.IO Gateway for live operational invalidation signals.
 * Sockets join strictly their server-resolved `org:<organizationId>` room.
 * Inbound client-to-server mutations are strictly forbidden.
 */
@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  private activeConnectionsCount = 0;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('[RealtimeGateway] WebSocket server initialized');
  }

  async handleConnection(client: Socket) {
    try {
      // 1. Extract token strictly from auth payload or Authorization header (NEVER from query string)
      const authHeader = client.handshake.headers['authorization'];
      let token: string | undefined = client.handshake.auth?.token;

      if (!token && authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }

      if (!token) {
        this.logger.warn(`[RealtimeGateway] Connection rejected (${client.id}): Missing authentication token`);
        client.emit('auth_error', { message: 'Missing authentication token' });
        client.disconnect(true);
        return;
      }

      // 2. Verify JWT signature and expiration
      const secret = this.configService.get<string>('jwtAccessSecret');
      let payload: JwtPayload & { exp?: number; iat?: number };
      try {
        payload = await this.jwtService.verifyAsync<JwtPayload & { exp?: number; iat?: number }>(token, { secret });
      } catch (jwtErr: unknown) {
        this.logger.warn(
          `[RealtimeGateway] Connection rejected (${client.id}): Invalid or expired access token (${(jwtErr as Error).message})`,
        );
        client.emit('auth_error', { message: 'Invalid or expired access token' });
        client.disconnect(true);
        return;
      }

      if (payload.type !== 'access' || !payload.orgId || !payload.sub) {
        this.logger.warn(`[RealtimeGateway] Connection rejected (${client.id}): Malformed token claims`);
        client.emit('auth_error', { message: 'Malformed token claims' });
        client.disconnect(true);
        return;
      }

      // 3. Authoritatively verify organization membership in PostgreSQL
      const membership = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: payload.orgId,
            userId: payload.sub,
          },
        },
      });

      if (!membership) {
        this.logger.warn(
          `[RealtimeGateway] Connection rejected (${client.id}): User ${payload.sub} is not an active member of organization ${payload.orgId}`,
        );
        client.emit('auth_error', { message: 'User is not an active member of this organization' });
        client.disconnect(true);
        return;
      }

      // 4. Token-lifetime enforcement: Check expiration and schedule disconnect at JWT exp
      const nowInSeconds = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp <= nowInSeconds) {
        this.logger.warn(`[RealtimeGateway] Connection rejected (${client.id}): Access token has expired`);
        client.emit('auth_error', { message: 'Invalid or expired access token' });
        client.disconnect(true);
        return;
      }

      const remainingSeconds = payload.exp ? payload.exp - nowInSeconds : 15 * 60;
      const expiresInMs = remainingSeconds * 1000;

      const disconnectTimer = setTimeout(() => {
        this.logger.log(`[RealtimeGateway] Socket ${client.id} access token reached expiration. Disconnecting.`);
        client.emit('auth:expired', { message: 'Access token expired' });
        client.disconnect(true);
      }, expiresInMs);

      if (typeof disconnectTimer.unref === 'function') {
        disconnectTimer.unref();
      }

      client.data.disconnectTimer = disconnectTimer;

      // 5. Attach authenticated user context and bind strictly to server-derived organization room
      const authenticatedUser: AuthenticatedUser = {
        userId: payload.sub,
        email: payload.email,
        organizationId: payload.orgId,
        sessionId: payload.sessionId,
        role: membership.role as any,
      };

      client.data.user = authenticatedUser;
      const orgRoom = `org:${payload.orgId}`;
      client.join(orgRoom);
      this.activeConnectionsCount++;

      this.logger.log(
        `[RealtimeGateway] Socket connected: ${client.id} (user: ${payload.sub}, role: ${membership.role}) joined room: ${orgRoom}. Total active: ${this.activeConnectionsCount}`,
      );

      // Acknowledge connection
      client.emit('connected', {
        organizationId: payload.orgId,
        connectedAt: new Date().toISOString(),
      });

      // 6. Inbound mutation guard: Reject any client-to-server business mutation commands
      client.onAny((event: string) => {
        if (event !== 'ping' && event !== 'disconnect') {
          this.logger.debug(
            `[RealtimeGateway] Client ${client.id} attempted inbound event "${event}". Inbound mutations over WebSocket are not supported.`,
          );
          client.emit('error', {
            code: 'MUTATION_FORBIDDEN',
            message: 'Inbound client mutations over WebSocket are not supported. Use authenticated REST endpoints.',
          });
        }
      });
    } catch (err: unknown) {
      this.logger.error(`[RealtimeGateway] Error during socket handshake: ${(err as Error).message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    if (client.data?.disconnectTimer) {
      clearTimeout(client.data.disconnectTimer);
      client.data.disconnectTimer = undefined;
    }

    if (client.data?.user) {
      this.activeConnectionsCount = Math.max(0, this.activeConnectionsCount - 1);
      this.logger.log(
        `[RealtimeGateway] Socket disconnected: ${client.id} (org: ${client.data.user.organizationId}). Total active: ${this.activeConnectionsCount}`,
      );
    }
  }

  /**
   * Emits an invalidation notification to the authorized organization room.
   */
  emitToOrganization(notification: RealtimeNotification): void {
    if (!this.server) {
      this.logger.warn(`[RealtimeGateway] Server instance not ready to emit ${notification.eventType}`);
      return;
    }

    const room = `org:${notification.organizationId}`;

    // Emit typed event
    this.server.to(room).emit(notification.eventType, notification);

    // Also emit generic invalidation envelope for consolidated listeners
    this.server.to(room).emit('realtime:event', notification);
    this.server.to(room).emit('realtime.event', notification);

    this.logger.debug(
      `[RealtimeGateway] Emitted ${notification.eventType} to room ${room} (resourceId: ${notification.resourceId ?? 'N/A'})`,
    );
  }

  getActiveConnectionsCount(): number {
    return this.activeConnectionsCount;
  }

  async onModuleDestroy() {
    if (this.server) {
      try {
        const sockets = await this.server.fetchSockets().catch(() => []);
        for (const s of sockets) {
          if ((s as any).data?.disconnectTimer) {
            clearTimeout((s as any).data.disconnectTimer);
            (s as any).data.disconnectTimer = undefined;
          }
          s.disconnect(true);
        }
        this.server.close();
      } catch (err: unknown) {
        this.logger.warn(`Error during Socket.IO server shutdown: ${(err as Error).message}`);
      }
    }
  }
}
