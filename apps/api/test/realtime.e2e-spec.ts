if (!process.env.TEST_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
}
if (!process.env.TEST_DATABASE_URL) {
  process.env.TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/reloop?schema=public';
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!process.env.JWT_ACCESS_SECRET) {
  process.env.JWT_ACCESS_SECRET = 'safe_local_e2e_jwt_access_secret_32_characters_minimum';
}
if (!process.env.JWT_REFRESH_SECRET) {
  process.env.JWT_REFRESH_SECRET = 'safe_local_e2e_jwt_refresh_secret_32_characters_minimum';
}
if (!process.env.REDIS_URL) {
  process.env.REDIS_URL = 'redis://localhost:6380';
}

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { io, Socket } from 'socket.io-client';
import Redis from 'ioredis';

import { PrismaService } from '../src/prisma/prisma.service';
import { RealtimePublisher } from '../src/realtime/realtime.publisher';
import { Role } from '@reloop/database';
import { SecurityUtil } from '../src/auth/security.util';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RealtimeNotification } from '@reloop/contracts';

describe('Day 20: Realtime Operations & Multi-Tenant WebSocket E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let realtimePublisher: RealtimePublisher;
  let serverUrl: string;
  let redisClient: Redis;

  let orgAId: string;
  let orgBId: string;

  let tokenOwnerA: string;
  let tokenOwnerB: string;
  let userAId: string;
  let jwtService: JwtService;
  let configService: ConfigService;

  const openSockets: Socket[] = [];

  beforeAll(async () => {
    jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_URL = 'postgresql://reloop:reloop_dev_password@localhost:5433/reloop_test?schema=public';
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

    if (!process.env.JWT_ACCESS_SECRET) {
      process.env.JWT_ACCESS_SECRET = 'safe_local_e2e_jwt_access_secret_32_characters_minimum';
    }
    if (!process.env.JWT_REFRESH_SECRET) {
      process.env.JWT_REFRESH_SECRET = 'safe_local_e2e_jwt_refresh_secret_32_characters_minimum';
    }
    if (!process.env.REDIS_URL) {
      process.env.REDIS_URL = 'redis://localhost:6380';
    }

    const { AppModule } = await import('../src/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );

    await app.init();
    const server = await app.listen(0);
    const address = server.address();
    const port = typeof address === 'string' ? address : address.port;
    serverUrl = `http://127.0.0.1:${port}`;

    prisma = app.get(PrismaService);
    realtimePublisher = app.get(RealtimePublisher);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);

    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
    redisClient = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redisClient.connect();

    await cleanDatabase();

    const hash = await SecurityUtil.hashPassword('Password123!');

    // Create Org A
    const orgA = await prisma.organization.create({
      data: { name: 'Acme Realtime Corp', slug: 'acme-realtime' },
    });
    orgAId = orgA.id;

    const userA = await prisma.user.create({
      data: { email: 'owner.a@realtimetest.com', name: 'Owner A', passwordHash: hash },
    });
    userAId = userA.id;
    await prisma.organizationMember.create({
      data: { organizationId: orgAId, userId: userA.id, role: Role.OWNER },
    });

    // Create Org B
    const orgB = await prisma.organization.create({
      data: { name: 'Beta Realtime Ltd', slug: 'beta-realtime' },
    });
    orgBId = orgB.id;

    const userB = await prisma.user.create({
      data: { email: 'owner.b@realtimetest.com', name: 'Owner B', passwordHash: hash },
    });
    await prisma.organizationMember.create({
      data: { organizationId: orgBId, userId: userB.id, role: Role.OWNER },
    });

    tokenOwnerA = (await loginUser('owner.a@realtimetest.com')).accessToken;
    tokenOwnerB = (await loginUser('owner.b@realtimetest.com')).accessToken;
  });

  afterEach(async () => {
    while (openSockets.length > 0) {
      const socket = openSockets.pop();
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket.close();
      }
    }
  });

  afterAll(async () => {
    while (openSockets.length > 0) {
      const socket = openSockets.pop();
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket.close();
      }
    }

    if (redisClient) {
      try {
        redisClient.disconnect();
      } catch {
        // ignore on shutdown
      }
    }

    await cleanDatabase().catch(() => {});
    await app.close().catch(() => {});
  });

  async function cleanDatabase() {
    await prisma.auditLog.deleteMany({});
    await prisma.approval.deleteMany({});
    await prisma.jobAttempt.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.workflowStep.deleteMany({});
    await prisma.workflow.deleteMany({});
    await prisma.recoveryCase.deleteMany({});
    await prisma.refreshSession.deleteMany({});
    await prisma.organizationMember.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});
  }

  async function loginUser(email: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'Password123!' })
      .expect(200);
    return res.body;
  }

  function createClientSocket(token?: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = io(serverUrl, {
        path: '/socket.io',
        auth: token ? { token } : undefined,
        transports: ['websocket'],
        reconnection: false,
        timeout: 5000,
      });

      openSockets.push(socket);

      socket.on('connected', () => {
        resolve(socket);
      });

      socket.on('connect_error', (err) => {
        reject(err);
      });

      socket.on('auth_error', (err) => {
        reject(new Error(err.message || 'auth_error'));
      });

      socket.on('disconnect', (reason) => {
        if (reason === 'io server disconnect') {
          reject(new Error(`Disconnected by server: ${reason}`));
        }
      });
    });
  }

  describe('1. Handshake Authentication & Room Binding', () => {
    it('successfully connects with valid JWT auth handshake and joins tenant room', async () => {
      const socket = await createClientSocket(tokenOwnerA);
      expect(socket.connected).toBe(true);
    });

    it('rejects connection without JWT token', async () => {
      await expect(createClientSocket()).rejects.toThrow();
    });

    it('rejects connection with invalid JWT token', async () => {
      await expect(createClientSocket('invalid.jwt.token.12345')).rejects.toThrow();
    });

    it('rejects connection with expired JWT token', async () => {
      const secret = configService.get<string>('jwtAccessSecret');
      const expiredToken = jwtService.sign(
        { sub: userAId, email: 'owner.a@realtimetest.com', orgId: orgAId, sessionId: 'expired-session-1', type: 'access' },
        { secret, expiresIn: '-5s' },
      );
      await expect(createClientSocket(expiredToken)).rejects.toThrow();
    });

    it('enforces token expiry during active connection, disconnects socket, and fresh token reconnects', async () => {
      const secret = configService.get<string>('jwtAccessSecret');
      const shortLivedToken = jwtService.sign(
        { sub: userAId, email: 'owner.a@realtimetest.com', orgId: orgAId, sessionId: 'short-session-2', type: 'access' },
        { secret, expiresIn: '1s' },
      );

      let authExpiredReceived = false;

      const socket = await new Promise<Socket>((resolve, reject) => {
        const s = io(serverUrl, {
          path: '/socket.io',
          auth: { token: shortLivedToken },
          transports: ['websocket'],
          reconnection: false,
          timeout: 5000,
        });

        openSockets.push(s);

        s.on('connected', () => resolve(s));
        s.on('connect_error', reject);
        s.on('auth_error', reject);
      });

      expect(socket.connected).toBe(true);

      socket.on('auth:expired', () => {
        authExpiredReceived = true;
      });

      await new Promise<void>((resolve) => {
        socket.on('disconnect', () => resolve());
        setTimeout(resolve, 3000);
      });

      expect(socket.connected).toBe(false);
      expect(authExpiredReceived).toBe(true);

      // Fresh token successfully connects on reconnect
      const freshSocket = await createClientSocket(tokenOwnerA);
      expect(freshSocket.connected).toBe(true);
    });
  });

  describe('2. Multi-Tenant Room Isolation', () => {
    it('delivers Org A events strictly to Org A sockets and NEVER to Org B sockets', async () => {
      const socketA = await createClientSocket(tokenOwnerA);
      const socketB = await createClientSocket(tokenOwnerB);

      const receivedByA: RealtimeNotification[] = [];
      const receivedByB: RealtimeNotification[] = [];

      socketA.on('realtime:event', (data: RealtimeNotification) => {
        receivedByA.push(data);
      });

      socketB.on('realtime:event', (data: RealtimeNotification) => {
        receivedByB.push(data);
      });

      // Publish event strictly targeted to Org A
      const testEventA: RealtimeNotification = {
        organizationId: orgAId,
        eventType: 'recovery.updated',
        resourceId: 'wf-test-isolation-1',
        resourceType: 'RECOVERY',
        status: 'RUNNING',
        changedAt: new Date().toISOString(),
      };

      await realtimePublisher.publish(testEventA);

      // Wait 600ms for event propagation
      await new Promise((r) => setTimeout(r, 600));

      expect(receivedByA.length).toBe(1);
      expect(receivedByA[0].resourceId).toBe('wf-test-isolation-1');
      expect(receivedByA[0].status).toBe('RUNNING');

      // Org B socket MUST receive zero events
      expect(receivedByB.length).toBe(0);
    });
  });

  describe('3. Inbound Client Mutations Fencing', () => {
    it('discards/ignores inbound client mutation attempts over socket', async () => {
      const socket = await createClientSocket(tokenOwnerA);

      // Attempt to send illegal mutation over WebSocket
      socket.emit('approval:decide', { approvalId: 'illegal-id', decision: 'APPROVED' });
      socket.emit('realtime:event', { organizationId: orgBId, eventType: 'dashboard.changed' });

      await new Promise((r) => setTimeout(r, 400));

      // Check that database remains completely unchanged
      const approvalsCount = await prisma.approval.count();
      expect(approvalsCount).toBe(0);
    });
  });

  describe('4. Multi-Instance Redis Pub/Sub Fanout', () => {
    it('receives events published across independent Redis channels', async () => {
      const socketA = await createClientSocket(tokenOwnerA);

      const receivedEvents: RealtimeNotification[] = [];
      socketA.on('realtime:event', (data: RealtimeNotification) => {
        receivedEvents.push(data);
      });

      // Directly publish into Redis pub/sub channel mimicking another API server instance
      const externalInstanceEvent: RealtimeNotification = {
        organizationId: orgAId,
        eventType: 'dashboard.changed',
        resourceType: 'DASHBOARD',
        changedAt: new Date().toISOString(),
      };

      await redisClient.publish('reloop:realtime:events', JSON.stringify(externalInstanceEvent));

      await new Promise((r) => setTimeout(r, 600));

      expect(receivedEvents.length).toBeGreaterThanOrEqual(1);
      const found = receivedEvents.find((e) => e.eventType === 'dashboard.changed');
      expect(found).toBeDefined();
    });
  });

  describe('5. Realtime Event Contract Consistency & Invalidation Invariants', () => {
    it('ensures realtime notifications strictly contain safe metadata without PII or credentials', async () => {
      const socketA = await createClientSocket(tokenOwnerA);

      const receivedEvents: RealtimeNotification[] = [];
      socketA.on('realtime:event', (data: RealtimeNotification) => {
        receivedEvents.push(data);
      });

      const safeNotification: RealtimeNotification = {
        organizationId: orgAId,
        eventType: 'exception.updated',
        resourceId: 'case-123',
        resourceType: 'EXCEPTION',
        orderId: 'order-456',
        status: 'OPEN',
        changedAt: new Date().toISOString(),
        reason: 'Sync discrepancy detected',
      };

      await realtimePublisher.publish(safeNotification);
      await new Promise((r) => setTimeout(r, 400));

      expect(receivedEvents.length).toBeGreaterThanOrEqual(1);
      const event = receivedEvents.find((e) => e.resourceId === 'case-123')!;
      expect(event).toBeDefined();
      expect(event.eventType).toBe('exception.updated');
      expect(event.orderId).toBe('order-456');

      // Security assertion: verify no sensitive keys exist on payload
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('apiKey');
      expect(serialized).not.toContain('token');
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('credentials');
    });
  });
});
