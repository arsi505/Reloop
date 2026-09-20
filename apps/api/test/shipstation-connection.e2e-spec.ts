import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Configuration error: TEST_DATABASE_URL environment variable is required for E2E tests.');
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.INTEGRATION_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Role } from '@reloop/database';
import { SecurityUtil } from '../src/auth/security.util';
import { decryptCredentials } from '@reloop/connector-shipstation';
import { StoredShipStationCredential, EncryptedCredentialEnvelope } from '@reloop/integration-sdk';

describe('ShipStation Connection & Credential Security E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let ownerToken: string;
  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;
  let orgId: string;

  const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const validApiKey = 'shipstation_valid_test_api_key_12345';
  const invalidApiKey = 'shipstation_invalid_key_99999';

  let originalFetch: typeof fetch;

  beforeAll(async () => {
    originalFetch = globalThis.fetch;

    // Mock global fetch for ShipStation API V2 endpoints
    globalThis.fetch = async (input: any, init?: any): Promise<Response> => {
      const urlStr = String(input);
      const headers = (init?.headers as Record<string, string>) || {};
      const keyHeader = headers['api-key'];

      if (urlStr.includes('api.shipstation.com/v2')) {
        if (keyHeader === invalidApiKey) {
          return new Response(
            JSON.stringify({ message: 'Unauthorized API key' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (keyHeader === 'rate_limited_key') {
          return new Response(
            JSON.stringify({ message: 'Too Many Requests' }),
            { status: 429, headers: { 'Content-Type': 'application/json', 'retry-after': '5' } },
          );
        }
        // Success mock
        return new Response(
          JSON.stringify({
            shipments: [],
            total: 15,
            page: 1,
            pages: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return originalFetch(input, init);
    };

    jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);
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
    prisma = app.get(PrismaService);

    // Clean test database tables
    await prisma.approval.deleteMany({});
    await prisma.workflowStep.deleteMany({});
    await prisma.workflow.deleteMany({});
    await prisma.recoveryCase.deleteMany({});
    await prisma.integrationEvent.deleteMany({});
    await prisma.externalReference.deleteMany({});
    await prisma.externalOrder.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.oAuthState.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.integration.deleteMany({});
    await prisma.refreshSession.deleteMany({});
    await prisma.organizationMember.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});

    // Seed Primary Organization
    const primaryOrg = await prisma.organization.create({
      data: { name: 'Acme Logistics Brand', slug: 'acme-logistics' },
    });
    orgId = primaryOrg.id;

    // Helper to create users with access tokens
    const createUser = async (email: string, role: Role, organizationId: string) => {
      const passwordHash = await SecurityUtil.hashPassword('Password123!');
      const user = await prisma.user.create({
        data: { email, name: email.split('@')[0], passwordHash },
      });
      await prisma.organizationMember.create({
        data: { organizationId, userId: user.id, role },
      });
      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'Password123!' });
      return loginRes.body.accessToken as string;
    };

    ownerToken = await createUser('owner@acme-ss.com', Role.OWNER, orgId);
    adminToken = await createUser('admin@acme-ss.com', Role.ADMIN, orgId);
    operatorToken = await createUser('operator@acme-ss.com', Role.OPERATOR, orgId);
    viewerToken = await createUser('viewer@acme-ss.com', Role.VIEWER, orgId);
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
  });

  describe('1. RBAC on Connect Endpoint (POST /integrations/shipstation/connect)', () => {
    it('blocks unauthenticated requests with 401', async () => {
      const res = await request(app.getHttpServer())
        .post('/integrations/shipstation/connect')
        .send({ apiKey: validApiKey });

      expect(res.status).toBe(401);
    });

    it('blocks OPERATOR with 403 Forbidden', async () => {
      const res = await request(app.getHttpServer())
        .post('/integrations/shipstation/connect')
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ apiKey: validApiKey });

      expect(res.status).toBe(403);
    });

    it('blocks VIEWER with 403 Forbidden', async () => {
      const res = await request(app.getHttpServer())
        .post('/integrations/shipstation/connect')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ apiKey: validApiKey });

      expect(res.status).toBe(403);
    });

    it('rejects connecting with invalid API key (401 Unauthorized)', async () => {
      const res = await request(app.getHttpServer())
        .post('/integrations/shipstation/connect')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ apiKey: invalidApiKey });

      expect(res.status).toBe(401);
      expect(res.body.message).toContain('Invalid ShipStation API key');

      // Verify no integration was saved
      const count = await prisma.integration.count({
        where: { organizationId: orgId, provider: 'SHIPSTATION' },
      });
      expect(count).toBe(0);
    });
  });

  describe('2. Successful Connection, Encryption & Durable Sync Enqueue', () => {
    let integrationId: string;

    it('allows OWNER to connect with valid API key, encrypts credentials, and enqueues sync job', async () => {
      const res = await request(app.getHttpServer())
        .post('/integrations/shipstation/connect')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ apiKey: validApiKey });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.integrationId).toBeDefined();
      expect(res.body.totalShipments).toBe(15);
      integrationId = res.body.integrationId;

      // Verify database state
      const integration = await prisma.integration.findUnique({
        where: { id: integrationId },
      });
      expect(integration).toBeDefined();
      expect(integration?.organizationId).toBe(orgId);
      expect(integration?.provider).toBe('SHIPSTATION');
      expect(integration?.status).toBe('CONNECTED');
      expect(integration?.mode).toBe('OBSERVE');

      // Verify encrypted credentials
      const envelope = integration?.encryptedCredentials as unknown as EncryptedCredentialEnvelope;
      expect(envelope).toBeDefined();
      expect(envelope.algorithm).toBe('aes-256-gcm');
      expect(envelope.ciphertext).toBeDefined();

      // Ensure plaintext key is NOT stored raw anywhere in JSON
      const rawJson = JSON.stringify(integration?.encryptedCredentials);
      expect(rawJson).not.toContain(validApiKey);

      // Decrypt credentials and verify payload
      const decrypted = decryptCredentials<StoredShipStationCredential>(envelope, masterKey);
      expect(decrypted.apiKey).toBe(validApiKey);
      expect(decrypted.validatedAt).toBeDefined();

      // Verify Audit Log
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          organizationId: orgId,
          entityId: integrationId,
          action: 'SHIPSTATION_INTEGRATION_CONNECTED',
        },
      });
      expect(auditLog).toBeDefined();
      expect((auditLog?.metadata as any)?.provider).toBe('SHIPSTATION');

      // Verify Durable Sync Job
      const job = await prisma.job.findFirst({
        where: {
          organizationId: orgId,
          type: 'SHIPSTATION_SYNC_SHIPMENTS',
        },
      });
      expect(job).toBeDefined();
      expect(job?.status).toBe('QUEUED');
      expect((job?.payload as any)?.integrationId).toBe(integrationId);
    });

    it('returns safe status without credentials via GET /integrations/:id/status', async () => {
      const res = await request(app.getHttpServer())
        .get(`/integrations/${integrationId}/status`)
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(integrationId);
      expect(res.body.provider).toBe('SHIPSTATION');
      expect(res.body.status).toBe('CONNECTED');
      expect(res.body.apiKey).toBeUndefined();
      expect(res.body.encryptedCredentials).toBeUndefined();
    });

    it('allows ADMIN to replace credentials after successful validation', async () => {
      const newValidKey = 'shipstation_replacement_key_54321';

      // First test with invalid key -> rejected and existing key preserved
      const failRes = await request(app.getHttpServer())
        .post(`/integrations/shipstation/${integrationId}/credentials/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ apiKey: invalidApiKey });

      expect(failRes.status).toBe(401);

      // Verify old credentials still intact
      let integration = await prisma.integration.findUnique({ where: { id: integrationId } });
      let envelope = integration?.encryptedCredentials as unknown as EncryptedCredentialEnvelope;
      let decrypted = decryptCredentials<StoredShipStationCredential>(envelope, masterKey);
      expect(decrypted.apiKey).toBe(validApiKey);

      // Now test with valid new key
      const okRes = await request(app.getHttpServer())
        .post(`/integrations/shipstation/${integrationId}/credentials/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ apiKey: newValidKey });

      expect(okRes.status).toBe(201);
      expect(okRes.body.success).toBe(true);

      // Verify new credentials replaced
      integration = await prisma.integration.findUnique({ where: { id: integrationId } });
      envelope = integration?.encryptedCredentials as unknown as EncryptedCredentialEnvelope;
      decrypted = decryptCredentials<StoredShipStationCredential>(envelope, masterKey);
      expect(decrypted.apiKey).toBe(newValidKey);

      // Verify audit log for replacement
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          organizationId: orgId,
          entityId: integrationId,
          action: 'SHIPSTATION_CREDENTIALS_REPLACED',
        },
      });
      expect(auditLog).toBeDefined();
    });

    it('allows OWNER to disconnect integration, blanks credentials safely, and records audit log', async () => {
      const res = await request(app.getHttpServer())
        .post(`/integrations/${integrationId}/disconnect`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const integration = await prisma.integration.findUnique({
        where: { id: integrationId },
      });
      expect(integration?.status).toBe('DISCONNECTED');
      expect(integration?.encryptedCredentials).toBeNull();

      // Verify audit log
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          organizationId: orgId,
          entityId: integrationId,
          action: 'SHIPSTATION_INTEGRATION_DISCONNECTED',
        },
      });
      expect(auditLog).toBeDefined();
    });
  });
});
