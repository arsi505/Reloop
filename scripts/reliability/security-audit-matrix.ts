import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as crypto from 'crypto';
import {
  PrismaClient,
  Role,
  IntegrationProvider,
  IntegrationStatus,
  RecoveryCaseStatus,
  RecoveryCaseType,
  RecoveryLevel,
  ApprovalStatus,
} from '@prisma/client';
import { AppModule } from '../../apps/api/src/app.module';
import { SecurityUtil } from '../../apps/api/src/auth/security.util';
import { ShopifyOAuthService } from '../../apps/api/src/integrations/shopify-oauth.service';
import configurationFactory from '../../apps/api/src/config/configuration';
import { AllExceptionsFilter } from '../../apps/api/src/common/filters/http-exception.filter';
import {
  encryptCredentials,
  decryptCredentials,
  parseMasterEncryptionKey,
  EncryptionError,
} from '../../connectors/shopify/src/crypto';
import {
  normalizeAndValidateShopDomain,
  ShopifyDomainValidationError,
} from '../../connectors/shopify/src/domain-validator';
import { sanitizeErrorMessage } from '../../apps/worker/src/errors';
import { SimulatorWebhookAdapter } from '../../connectors/simulator/src/simulator-webhook-adapter';

// Ensure consistent test environment variables
const dbUrl =
  process.env.RELOOP_TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://reloop@localhost:5433/reloop_test?schema=public';
process.env.DATABASE_URL = dbUrl;
process.env.TEST_DATABASE_URL = dbUrl;
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'security_audit_test_jwt_secret_0123456789abcdef';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3100';
process.env.INTEGRATION_ENCRYPTION_KEY =
  process.env.INTEGRATION_ENCRYPTION_KEY ||
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SHOPIFY_CLIENT_SECRET = 'audit_shopify_client_secret_test_123';

export interface AuditResult {
  checkNumber: number;
  category: string;
  check: string;
  passed: boolean;
  details: string;
}

const auditResults: AuditResult[] = [];
let checkCounter = 0;

function recordResult(category: string, check: string, passed: boolean, details: string) {
  checkCounter++;
  auditResults.push({ checkNumber: checkCounter, category, check, passed, details });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`  [${icon}] #${checkCounter} [${category}] ${check}: ${details}`);
}

function getCookies(res: request.Response): string[] {
  const c = res.headers['set-cookie'];
  if (Array.isArray(c)) return c;
  if (typeof c === 'string') return [c];
  return [];
}

async function main() {
  console.log('========================================================================');
  console.log('  RELOOP DAY 22: COMPREHENSIVE SECURITY-GAP & READINESS VERIFICATION   ');
  console.log('========================================================================\n');

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  await prisma.$connect();

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app: INestApplication = moduleFixture.createNestApplication({ rawBody: true });
  app.use(cookieParser());
  app.enableCors({
    origin: [process.env.FRONTEND_URL || 'http://localhost:3100'],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  const server = app.getHttpServer();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any): Promise<Response> => {
    const urlStr = String(input);
    if (urlStr.includes('api.shipstation.com/v2')) {
      return new Response(
        JSON.stringify({ shipments: [], total: 10, page: 1, pages: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
  };

  const runId = Math.random().toString(36).substring(2, 8);
  const passwordPlain = 'SuperSecureP@ss123!';
  const passwordHash = await SecurityUtil.hashPassword(passwordPlain);

  // --------------------------------------------------------------------------
  // Provision Test Organizations & Role-Based Users
  // --------------------------------------------------------------------------
  console.log('--- Provisioning Test Tenancy & Role Matrix ---');

  // Org A
  const orgA = await prisma.organization.create({
    data: {
      name: `Security Org A ${runId}`,
      slug: `sec-org-a-${runId}`,
    },
  });

  // Org B
  const orgB = await prisma.organization.create({
    data: {
      name: `Security Org B ${runId}`,
      slug: `sec-org-b-${runId}`,
    },
  });

  // Create Users in Org A for all 4 roles: OWNER, ADMIN, OPERATOR, VIEWER
  const userOwnerA = await prisma.user.create({
    data: { email: `owner-${runId}@example.com`, passwordHash, name: 'Owner User' },
  });
  await prisma.organizationMember.create({
    data: { organizationId: orgA.id, userId: userOwnerA.id, role: Role.OWNER },
  });

  const userAdminA = await prisma.user.create({
    data: { email: `admin-${runId}@example.com`, passwordHash, name: 'Admin User' },
  });
  await prisma.organizationMember.create({
    data: { organizationId: orgA.id, userId: userAdminA.id, role: Role.ADMIN },
  });

  const userOperatorA = await prisma.user.create({
    data: { email: `operator-${runId}@example.com`, passwordHash, name: 'Operator User' },
  });
  await prisma.organizationMember.create({
    data: { organizationId: orgA.id, userId: userOperatorA.id, role: Role.OPERATOR },
  });

  const userViewerA = await prisma.user.create({
    data: { email: `viewer-${runId}@example.com`, passwordHash, name: 'Viewer User' },
  });
  await prisma.organizationMember.create({
    data: { organizationId: orgA.id, userId: userViewerA.id, role: Role.VIEWER },
  });

  // Org B Owner for cross-tenant testing
  const userOwnerB = await prisma.user.create({
    data: { email: `owner-b-${runId}@example.com`, passwordHash, name: 'Owner B' },
  });
  await prisma.organizationMember.create({
    data: { organizationId: orgB.id, userId: userOwnerB.id, role: Role.OWNER },
  });

  // Acquire tokens for all roles in Org A
  const loginRole = async (email: string) => {
    const res = await request(server)
      .post('/auth/login')
      .send({ email, password: passwordPlain });
    return res.body.accessToken as string;
  };

  const tokenOwner = await loginRole(userOwnerA.email);
  const tokenAdmin = await loginRole(userAdminA.email);
  const tokenOperator = await loginRole(userOperatorA.email);
  const tokenViewer = await loginRole(userViewerA.email);
  const tokenOwnerB = await loginRole(userOwnerB.email);

  // Setup test recovery cases & approvals
  const caseA = await prisma.recoveryCase.create({
    data: {
      organizationId: orgA.id,
      status: RecoveryCaseStatus.OPEN,
      type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
      recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
      summary: 'RBAC test case in Org A',
      evidence: { orderId: `ORDER-${runId}-A` },
    },
  });

  const approvalA1 = await prisma.approval.create({
    data: {
      organizationId: orgA.id,
      recoveryCaseId: caseA.id,
      reason: 'Approval test 1',
      previewSnapshot: { change: 'address' },
      status: ApprovalStatus.PENDING,
    },
  });

  const approvalA2 = await prisma.approval.create({
    data: {
      organizationId: orgA.id,
      recoveryCaseId: caseA.id,
      reason: 'Approval test 2',
      previewSnapshot: { change: 'address' },
      status: ApprovalStatus.PENDING,
    },
  });

  const approvalA3 = await prisma.approval.create({
    data: {
      organizationId: orgA.id,
      recoveryCaseId: caseA.id,
      reason: 'Approval test 3',
      previewSnapshot: { change: 'address' },
      status: ApprovalStatus.PENDING,
    },
  });

  const approvalA4 = await prisma.approval.create({
    data: {
      organizationId: orgA.id,
      recoveryCaseId: caseA.id,
      reason: 'Approval test 4',
      previewSnapshot: { change: 'address' },
      status: ApprovalStatus.PENDING,
    },
  });

  // Setup Org B approval for tenant isolation check
  const caseB = await prisma.recoveryCase.create({
    data: {
      organizationId: orgB.id,
      status: RecoveryCaseStatus.OPEN,
      type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
      recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
      summary: 'Confidential case in Org B',
      evidence: { orderId: `ORDER-${runId}-B` },
    },
  });

  const approvalB = await prisma.approval.create({
    data: {
      organizationId: orgB.id,
      recoveryCaseId: caseB.id,
      reason: 'Confidential change Org B',
      previewSnapshot: { confidentialData: 'org_b_secret_data' },
      status: ApprovalStatus.PENDING,
    },
  });

  // Setup ShipStation integration in Org A for credential testing
  const shipstationA = await prisma.integration.create({
    data: {
      organizationId: orgA.id,
      provider: IntegrationProvider.SHIPSTATION,
      status: IntegrationStatus.CONNECTED,
      name: 'ShipStation Org A',
      configuration: { apiKey: 'dummy_initial_api_key' },
    },
  });

  // Setup simulator integration for webhook tests
  const webhookSecret = 'test_webhook_hmac_secret_audit_123';
  const integrationSimulator = await prisma.integration.create({
    data: {
      organizationId: orgA.id,
      provider: IntegrationProvider.SIMULATOR,
      status: IntegrationStatus.CONNECTED,
      name: 'Simulator Org A',
      configuration: { webhookSecret },
    },
  });

  try {
    // ========================================================================
    // 1. Authentication & Cookie Construction
    // ========================================================================
    console.log('\n--- 1. Authentication & Cookie Construction ---');
    const unauthRes = await request(server).get('/approvals');
    recordResult(
      'Authentication',
      'Unauthenticated request rejected with 401',
      unauthRes.status === 401,
      `Received HTTP ${unauthRes.status}`,
    );

    const loginRes = await request(server)
      .post('/auth/login')
      .send({ email: userOwnerA.email, password: passwordPlain });

    const cookies = getCookies(loginRes);
    const refreshCookie = cookies.find((c) => c.startsWith('reloop_refresh='));
    const isHttpOnly = !!refreshCookie && refreshCookie.includes('HttpOnly');
    const isSameSiteLax = !!refreshCookie && refreshCookie.toLowerCase().includes('samesite=lax');
    const hasPathAuth = !!refreshCookie && refreshCookie.includes('Path=/auth');

    recordResult(
      'Session Security',
      'Refresh cookie constructed with HttpOnly, SameSite=Lax, Path=/auth',
      isHttpOnly && isSameSiteLax && hasPathAuth,
      `HttpOnly: ${isHttpOnly}, SameSite=Lax: ${isSameSiteLax}, Path=/auth: ${hasPathAuth}`,
    );

    // ========================================================================
    // 2. Tenant Isolation
    // ========================================================================
    console.log('\n--- 2. Tenant Isolation ---');
    const crossTenantRes = await request(server)
      .get(`/approvals/${approvalB.id}`)
      .set('Authorization', `Bearer ${tokenOwner}`);

    recordResult(
      'Tenant Isolation',
      'Cross-tenant resource access denied (404/403 - no information leak)',
      crossTenantRes.status === 404 || crossTenantRes.status === 403,
      `User Org A accessing Org B approval received HTTP ${crossTenantRes.status}`,
    );

    // ========================================================================
    // 3. Full RBAC Matrix: Approvals
    // ========================================================================
    console.log('\n--- 3. Full RBAC Matrix: Approvals ---');
    // OWNER approves
    const ownerApproveRes = await request(server)
      .post(`/approvals/${approvalA1.id}/approve`)
      .set('Authorization', `Bearer ${tokenOwner}`)
      .send({ note: 'Approved by OWNER' });
    recordResult(
      'RBAC',
      'OWNER role permitted to approve (HTTP 200/201)',
      ownerApproveRes.status === 200 || ownerApproveRes.status === 201,
      `Received HTTP ${ownerApproveRes.status}`,
    );

    // ADMIN rejects
    const adminRejectRes = await request(server)
      .post(`/approvals/${approvalA2.id}/reject`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ reason: 'Rejected by ADMIN' });
    recordResult(
      'RBAC',
      'ADMIN role permitted to reject (HTTP 200/201)',
      adminRejectRes.status === 200 || adminRejectRes.status === 201,
      `Received HTTP ${adminRejectRes.status}`,
    );

    // OPERATOR approves
    const operatorApproveRes = await request(server)
      .post(`/approvals/${approvalA3.id}/approve`)
      .set('Authorization', `Bearer ${tokenOperator}`)
      .send({ note: 'Approved by OPERATOR' });
    recordResult(
      'RBAC',
      'OPERATOR role permitted to approve (HTTP 200/201)',
      operatorApproveRes.status === 200 || operatorApproveRes.status === 201,
      `Received HTTP ${operatorApproveRes.status}`,
    );

    // VIEWER forbidden from approving
    const viewerApproveRes = await request(server)
      .post(`/approvals/${approvalA4.id}/approve`)
      .set('Authorization', `Bearer ${tokenViewer}`)
      .send({ note: 'Attempt by VIEWER' });
    recordResult(
      'RBAC',
      'VIEWER role forbidden from approving (HTTP 403)',
      viewerApproveRes.status === 403,
      `Received HTTP ${viewerApproveRes.status}`,
    );

    // VIEWER forbidden from rejecting
    const viewerRejectRes = await request(server)
      .post(`/approvals/${approvalA4.id}/reject`)
      .set('Authorization', `Bearer ${tokenViewer}`)
      .send({ reason: 'Attempt by VIEWER' });
    recordResult(
      'RBAC',
      'VIEWER role forbidden from rejecting (HTTP 403)',
      viewerRejectRes.status === 403,
      `Received HTTP ${viewerRejectRes.status}`,
    );

    // ========================================================================
    // 4. Full RBAC Matrix: Integration Credential Management
    // ========================================================================
    console.log('\n--- 4. Full RBAC Matrix: Integration Credential Management ---');
    // OWNER connect integration
    const ownerConnectRes = await request(server)
      .post('/integrations/shopify/connect')
      .set('Authorization', `Bearer ${tokenOwner}`)
      .send({ shop: 'owner-store.myshopify.com' });
    recordResult(
      'RBAC',
      'OWNER role permitted to initiate integration connect',
      ownerConnectRes.status === 200 || ownerConnectRes.status === 201,
      `Received HTTP ${ownerConnectRes.status}`,
    );

    // ADMIN replace credentials
    const adminReplaceRes = await request(server)
      .post(`/integrations/shipstation/${shipstationA.id}/credentials/replace`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ apiKey: 'new_admin_api_key_123' });
    recordResult(
      'RBAC',
      'ADMIN role permitted to replace integration credentials',
      adminReplaceRes.status === 200 || adminReplaceRes.status === 201,
      `Received HTTP ${adminReplaceRes.status}`,
    );

    // OPERATOR forbidden from connecting integration
    const operatorConnectRes = await request(server)
      .post('/integrations/shopify/connect')
      .set('Authorization', `Bearer ${tokenOperator}`)
      .send({ shop: 'operator-store.myshopify.com' });
    recordResult(
      'RBAC',
      'OPERATOR role forbidden from connecting integrations (HTTP 403)',
      operatorConnectRes.status === 403,
      `Received HTTP ${operatorConnectRes.status}`,
    );

    // OPERATOR forbidden from replacing credentials
    const operatorReplaceRes = await request(server)
      .post(`/integrations/shipstation/${shipstationA.id}/credentials/replace`)
      .set('Authorization', `Bearer ${tokenOperator}`)
      .send({ apiKey: 'new_operator_api_key_123' });
    recordResult(
      'RBAC',
      'OPERATOR role forbidden from replacing credentials (HTTP 403)',
      operatorReplaceRes.status === 403,
      `Received HTTP ${operatorReplaceRes.status}`,
    );

    // VIEWER forbidden from connecting integration
    const viewerConnectRes = await request(server)
      .post('/integrations/shopify/connect')
      .set('Authorization', `Bearer ${tokenViewer}`)
      .send({ shop: 'viewer-store.myshopify.com' });
    recordResult(
      'RBAC',
      'VIEWER role forbidden from connecting integrations (HTTP 403)',
      viewerConnectRes.status === 403,
      `Received HTTP ${viewerConnectRes.status}`,
    );

    // VIEWER forbidden from disconnecting integration
    const viewerDisconnectRes = await request(server)
      .post(`/integrations/${shipstationA.id}/disconnect`)
      .set('Authorization', `Bearer ${tokenViewer}`);
    recordResult(
      'RBAC',
      'VIEWER role forbidden from disconnecting integrations (HTTP 403)',
      viewerDisconnectRes.status === 403,
      `Received HTTP ${viewerDisconnectRes.status}`,
    );

    // ========================================================================
    // 5. Session Security & Refresh CAS Rotation
    // ========================================================================
    console.log('\n--- 5. Session Security & Refresh CAS Rotation ---');
    // Rotate Token 1 -> Token 2
    const refreshRes1 = await request(server)
      .post('/auth/refresh')
      .set('Cookie', [refreshCookie!]);
    const cookies2 = getCookies(refreshRes1);
    const refreshCookie2 = cookies2.find((c) => c.startsWith('reloop_refresh='));

    recordResult(
      'Session Security',
      'Refresh token CAS rotation succeeds and issues new cookie',
      refreshRes1.status === 200 && !!refreshCookie2,
      `HTTP ${refreshRes1.status}, New cookie issued: ${!!refreshCookie2}`,
    );

    // Replay attack: attempt to reuse Token 1
    const replayRes = await request(server)
      .post('/auth/refresh')
      .set('Cookie', [refreshCookie!]);
    recordResult(
      'Session Security',
      'Replayed old refresh token strictly rejected with 401 (rotation conflict)',
      replayRes.status === 401,
      `Replayed old token received HTTP ${replayRes.status}`,
    );

    // Logout Token 2
    const logoutRes = await request(server)
      .post('/auth/logout')
      .set('Cookie', [refreshCookie2!]);
    recordResult(
      'Session Security',
      'Logout invalidates session and clears cookie',
      logoutRes.status === 200,
      `Received HTTP ${logoutRes.status}`,
    );

    // Attempt refresh after logout
    const postLogoutRefreshRes = await request(server)
      .post('/auth/refresh')
      .set('Cookie', [refreshCookie2!]);
    recordResult(
      'Session Security',
      'Refresh after logout strictly rejected with 401',
      postLogoutRefreshRes.status === 401,
      `Received HTTP ${postLogoutRefreshRes.status}`,
    );

    // ========================================================================
    // 6. CSRF Defenses / OriginGuard
    // ========================================================================
    console.log('\n--- 6. CSRF Defenses / OriginGuard ---');
    // State-changing cookie auth endpoint with unauthorized origin
    const csrfRefreshRes = await request(server)
      .post('/auth/refresh')
      .set('Origin', 'http://malicious-cross-origin.com')
      .set('Cookie', [refreshCookie2!]);
    recordResult(
      'CSRF Defenses',
      'State-changing auth endpoint with untrusted Origin rejected with 403',
      csrfRefreshRes.status === 403,
      `Received HTTP ${csrfRefreshRes.status}`,
    );

    const csrfLogoutRes = await request(server)
      .post('/auth/logout')
      .set('Origin', 'http://malicious-cross-origin.com')
      .set('Cookie', [refreshCookie2!]);
    recordResult(
      'CSRF Defenses',
      'Logout with untrusted Origin rejected with 403',
      csrfLogoutRes.status === 403,
      `Received HTTP ${csrfLogoutRes.status}`,
    );

    // ========================================================================
    // 7. Webhook Signature Security & Replay Deduplication
    // ========================================================================
    console.log('\n--- 7. Webhook Signature Security & Ingestion Deduplication ---');
    const webhookPayloadObj = {
      orderNumber: `ORD-AUDIT-${runId}`,
      externalOrderId: `ext_${runId}`,
      status: 'PAID',
      currency: 'USD',
      totalAmount: 149.99,
    };
    const rawPayload = JSON.stringify(webhookPayloadObj);
    const providerEventId = `evt_audit_precise_${runId}`;

    const validHmac = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawPayload, 'utf8')
      .digest('hex');

    // Missing signature
    const missingSigRes = await request(server)
      .post(`/webhooks/simulator/${integrationSimulator.id}`)
      .set('Content-Type', 'application/json')
      .set('x-reloop-event-id', providerEventId)
      .set('x-reloop-event-type', 'ORDER_CREATED')
      .send(rawPayload);
    recordResult(
      'Webhook Security',
      'Missing HMAC signature rejected with 401',
      missingSigRes.status === 401,
      `Received HTTP ${missingSigRes.status}`,
    );

    // Tampered / Invalid signature
    const invalidSigRes = await request(server)
      .post(`/webhooks/simulator/${integrationSimulator.id}`)
      .set('Content-Type', 'application/json')
      .set('x-reloop-signature', '0000000000000000000000000000000000000000000000000000000000000000')
      .set('x-reloop-event-id', providerEventId)
      .set('x-reloop-event-type', 'ORDER_CREATED')
      .send(rawPayload);
    recordResult(
      'Webhook Security',
      'Invalid HMAC signature rejected with 401',
      invalidSigRes.status === 401,
      `Received HTTP ${invalidSigRes.status}`,
    );

    // Valid signature accepted
    const validWebhookRes = await request(server)
      .post(`/webhooks/simulator/${integrationSimulator.id}`)
      .set('Content-Type', 'application/json')
      .set('x-reloop-signature', validHmac)
      .set('x-reloop-event-id', providerEventId)
      .set('x-reloop-event-type', 'ORDER_CREATED')
      .send(rawPayload);
    recordResult(
      'Webhook Security',
      'Valid HMAC signature accepted with 200 (accepted)',
      validWebhookRes.status === 200 && validWebhookRes.body?.status === 'accepted',
      `Received HTTP ${validWebhookRes.status} (status: ${validWebhookRes.body?.status})`,
    );

    // Replay: provider-event deduplication prevents repeated processing of the same persisted event
    const replayedWebhookRes = await request(server)
      .post(`/webhooks/simulator/${integrationSimulator.id}`)
      .set('Content-Type', 'application/json')
      .set('x-reloop-signature', validHmac)
      .set('x-reloop-event-id', providerEventId)
      .set('x-reloop-event-type', 'ORDER_CREATED')
      .send(rawPayload);
    recordResult(
      'Webhook Security',
      'Provider-event deduplication acknowledges replay as ignored_duplicate',
      replayedWebhookRes.status === 200 &&
        replayedWebhookRes.body?.status === 'ignored_duplicate',
      `Received HTTP ${replayedWebhookRes.status} (status: ${replayedWebhookRes.body?.status})`,
    );

    // ========================================================================
    // 8. OAuth State Complete Security (A: single-use, B: replay, C: expired, D: wrong shop)
    // ========================================================================
    console.log('\n--- 8. Complete OAuth State Security ---');
    const oauthService = app.get(ShopifyOAuthService);
    const oauthShop = `legit-store-${runId}.myshopify.com`;

    // Generate valid state
    const { state: stateA } = await oauthService.initiateConnect(orgA.id, userOwnerA.id, oauthShop);

    // A. Valid state consumed once
    const mockQueryA = {
      shop: oauthShop,
      code: 'valid_mock_code',
      state: stateA,
      hmac: 'valid_mock_hmac',
    };
    // Mock verifyCallbackHmac to true for synthetic state consumption verification
    const origVerifyHmac = oauthService.verifyCallbackHmac;
    oauthService.verifyCallbackHmac = () => true;

    // Synthetic mock fetch to return mock tokens and shop identity
    const mockFetch = async (url: string) => {
      if (typeof url === 'string' && url.includes('access_token')) {
        return new Response(
          JSON.stringify({ access_token: 'shpat_mock_123', scope: 'read_orders' }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            shop: {
              id: 'gid://shopify/Shop/1',
              myshopifyDomain: oauthShop,
              name: 'Legit Store',
            },
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    let consumedOnce = false;
    try {
      const res = await oauthService.handleCallback(mockQueryA, mockFetch as any);
      consumedOnce = res.success;
    } catch (e: any) {
      console.log('    OAuth consume error:', e.message);
    }
    recordResult(
      'OAuth Security',
      'A. Valid OAuth state consumed once successfully',
      consumedOnce,
      `State consumed: ${consumedOnce}`,
    );

    // B. Same state replayed -> rejected
    let replayedRejected = false;
    try {
      await oauthService.handleCallback(mockQueryA, mockFetch as any);
    } catch (e: any) {
      if (e.message.includes('already been used') || e.message.includes('already consumed')) {
        replayedRejected = true;
      }
    }
    recordResult(
      'OAuth Security',
      'B. Replayed OAuth state strictly rejected with 400',
      replayedRejected,
      `Replay caught: ${replayedRejected}`,
    );

    // C. Expired state -> rejected
    const expiredState = crypto.randomBytes(32).toString('hex');
    await prisma.oAuthState.create({
      data: {
        state: expiredState,
        organizationId: orgA.id,
        userId: userOwnerA.id,
        provider: 'SHOPIFY',
        shopDomain: oauthShop,
        expiresAt: new Date(Date.now() - 60000), // Expired 1 minute ago
      },
    });

    let expiredRejected = false;
    try {
      await oauthService.handleCallback(
        { ...mockQueryA, state: expiredState },
        mockFetch as any,
      );
    } catch (e: any) {
      if (e.message.includes('expired')) {
        expiredRejected = true;
      }
    }
    recordResult(
      'OAuth Security',
      'C. Expired OAuth state strictly rejected with 400',
      expiredRejected,
      `Expired state caught: ${expiredRejected}`,
    );

    // D. State bound to wrong shop/domain -> rejected
    const wrongShopState = crypto.randomBytes(32).toString('hex');
    await prisma.oAuthState.create({
      data: {
        state: wrongShopState,
        organizationId: orgA.id,
        userId: userOwnerA.id,
        provider: 'SHOPIFY',
        shopDomain: 'correct-store.myshopify.com',
        expiresAt: new Date(Date.now() + 600000),
      },
    });

    let wrongShopRejected = false;
    try {
      await oauthService.handleCallback(
        { ...mockQueryA, shop: 'different-attacker-store.myshopify.com', state: wrongShopState },
        mockFetch as any,
      );
    } catch (e: any) {
      if (e.message.includes('does not match callback shop domain')) {
        wrongShopRejected = true;
      }
    }
    recordResult(
      'OAuth Security',
      'D. OAuth state bound to wrong shop domain rejected with 400',
      wrongShopRejected,
      `Shop domain mismatch caught: ${wrongShopRejected}`,
    );

    // Restore verifyCallbackHmac
    oauthService.verifyCallbackHmac = origVerifyHmac;

    // ========================================================================
    // 9. SSRF Prevention on Shop Domain
    // ========================================================================
    console.log('\n--- 9. SSRF Prevention on Shop Domain ---');
    const maliciousDomains = [
      'evil.com',
      'attacker.myshopify.com.evil.com',
      'localhost',
      '127.0.0.1',
      '169.254.169.254',
      'https://legit.myshopify.com/path',
      'legit.myshopify.com:8080',
      'user:pass@legit.myshopify.com',
    ];

    let allMaliciousRejected = true;
    for (const bad of maliciousDomains) {
      try {
        normalizeAndValidateShopDomain(bad);
        allMaliciousRejected = false;
      } catch (e) {
        // Expected ShopifyDomainValidationError
      }
    }
    const validDomain = normalizeAndValidateShopDomain('  https://my-store.myshopify.com/  ');
    recordResult(
      'SSRF Prevention',
      'Rejects all malicious/internal SSRF patterns and normalizes canonical domain',
      allMaliciousRejected && validDomain === 'my-store.myshopify.com',
      `All ${maliciousDomains.length} SSRF patterns rejected; canonical normalized: ${validDomain}`,
    );

    // ========================================================================
    // 10. AES-256-GCM Credential Encryption & Wrong Key Test
    // ========================================================================
    console.log('\n--- 10. AES-256-GCM Credential Encryption & Wrong Key Test ---');
    const keyA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const keyB = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    const credentials = { token: 'secret_token_123', clientSecret: 'top_secret_456' };

    const envelopeA = encryptCredentials(credentials, keyA);
    const decryptedA = decryptCredentials<typeof credentials>(envelopeA, keyA);
    const roundtripSuccess = decryptedA.token === credentials.token;

    // Decrypt with Key B (wrong key)
    let wrongKeyFailedSafely = false;
    let leakedPlaintextOnWrongKey = false;
    try {
      const wrongDec = decryptCredentials<any>(envelopeA, keyB);
      if (wrongDec && wrongDec.token === credentials.token) leakedPlaintextOnWrongKey = true;
    } catch (e) {
      if (e instanceof EncryptionError) wrongKeyFailedSafely = true;
    }

    recordResult(
      'Encryption',
      'Decryption with different key B fails safely without plaintext leakage',
      wrongKeyFailedSafely && !leakedPlaintextOnWrongKey,
      `Decryption with wrong key threw EncryptionError: ${wrongKeyFailedSafely}, No plaintext leaked: ${!leakedPlaintextOnWrongKey}`,
    );

    // Tampered ciphertext
    let ciphertextTamperCaught = false;
    try {
      const tamperedEnv = { ...envelopeA, ciphertext: envelopeA.ciphertext.slice(0, -4) + 'AAAA' };
      decryptCredentials(tamperedEnv, keyA);
    } catch (e) {
      if (e instanceof EncryptionError) ciphertextTamperCaught = true;
    }

    // Tampered tag
    let tagTamperCaught = false;
    try {
      const tamperedTagEnv = { ...envelopeA, tag: Buffer.from('0123456789abcdef').toString('base64') };
      decryptCredentials(tamperedTagEnv, keyA);
    } catch (e) {
      if (e instanceof EncryptionError) tagTamperCaught = true;
    }

    recordResult(
      'Encryption',
      'Tampered ciphertext and authentication tag trigger EncryptionError',
      roundtripSuccess && ciphertextTamperCaught && tagTamperCaught,
      `Roundtrip: ${roundtripSuccess}, Ciphertext tamper caught: ${ciphertextTamperCaught}, Tag tamper caught: ${tagTamperCaught}`,
    );

    // Missing / invalid key format does not fall back to plaintext
    let invalidKeyFormatCaught = false;
    try {
      parseMasterEncryptionKey('short_invalid_key');
    } catch (e) {
      if (e instanceof EncryptionError) invalidKeyFormatCaught = true;
    }
    recordResult(
      'Encryption',
      'Invalid key format fails safely (does not fall back to plaintext)',
      invalidKeyFormatCaught,
      `Invalid key length rejected with EncryptionError: ${invalidKeyFormatCaught}`,
    );

    // ========================================================================
    // 11. Secret Sanitization & Log Redaction
    // ========================================================================
    console.log('\n--- 11. Secret Sanitization & Log Redaction ---');
    const dirtyString =
      'DB error: postgresql://reloop:MyPassword123@localhost:5433/db with Bearer eyJhbGciOiJIUz... and password=Secret123 and token=tok_abc';
    const cleanString = sanitizeErrorMessage(dirtyString);
    const noRawSecrets =
      !cleanString.includes('MyPassword123') &&
      !cleanString.includes('Secret123') &&
      !cleanString.includes('tok_abc') &&
      !cleanString.includes('eyJhbGciOiJIUz');

    recordResult(
      'Secret Redaction',
      'Sanitizes DB connection strings, passwords, tokens, and Bearer headers',
      noRawSecrets && cleanString.includes('[REDACTED]'),
      `Sanitized output contains no raw credentials: ${noRawSecrets}`,
    );

    // ========================================================================
    // 12. Input Validation & Mass Assignment Prevention
    // ========================================================================
    console.log('\n--- 12. Input Validation & Mass Assignment Prevention ---');
    const massAssignRes = await request(server)
      .post('/auth/login')
      .send({
        email: userOwnerA.email,
        password: passwordPlain,
        isAdmin: true,
        injectedField: 'malicious',
      });

    recordResult(
      'Input Validation',
      'Global ValidationPipe rejects non-whitelisted properties with 400',
      massAssignRes.status === 400 &&
        JSON.stringify(massAssignRes.body).includes('should not exist'),
      `Received HTTP ${massAssignRes.status} with forbidden property rejection`,
    );

    // ========================================================================
    // 13. CORS Configuration — Both Directions
    // ========================================================================
    console.log('\n--- 13. CORS Configuration — Both Directions ---');
    // Trusted origin
    const trustedCorsRes = await request(server)
      .get('/health')
      .set('Origin', 'http://localhost:3100');
    const trustedOriginHeader = trustedCorsRes.headers['access-control-allow-origin'];
    const allowCredentials = trustedCorsRes.headers['access-control-allow-credentials'];

    recordResult(
      'CORS Security',
      'Configured trusted frontend origin reflected with credentials allowed',
      trustedOriginHeader === 'http://localhost:3100' && allowCredentials === 'true',
      `Allow-Origin: ${trustedOriginHeader}, Allow-Credentials: ${allowCredentials}`,
    );

    // Untrusted origin
    const untrustedCorsRes = await request(server)
      .get('/health')
      .set('Origin', 'http://malicious-untrusted-site.com');
    const untrustedOriginHeader = untrustedCorsRes.headers['access-control-allow-origin'];

    recordResult(
      'CORS Security',
      'Arbitrary untrusted origin is strictly NOT allowed',
      untrustedOriginHeader !== 'http://malicious-untrusted-site.com',
      `Untrusted origin reflected: ${untrustedOriginHeader === 'http://malicious-untrusted-site.com'} (header: ${untrustedOriginHeader || 'Not reflected'})`,
    );

    // ========================================================================
    // 14. Login Rate Limiting (Bounded Repeat Attempts)
    // ========================================================================
    console.log('\n--- 14. Login Rate Limiting ---');
    // Send repeated failed login requests from a dedicated synthetic client
    const rateLimitIP = '198.51.100.42'; // RFC 5737 Test IP
    let rateLimitedStatus = 0;
    let allowedCount = 0;

    for (let i = 1; i <= 15; i++) {
      const rlRes = await request(server)
        .post('/auth/login')
        .set('X-Forwarded-For', rateLimitIP)
        .send({ email: `ratelimit-probe-${i}@example.com`, password: 'WrongPassword!' });

      if (rlRes.status === 429) {
        rateLimitedStatus = 429;
        break;
      } else {
        allowedCount++;
      }
    }

    recordResult(
      'Rate Limiting',
      'Repeated login attempts trigger HTTP 429 Too Many Requests',
      rateLimitedStatus === 429,
      `Requests permitted before limiting: ${allowedCount}, Rate-limited status: ${rateLimitedStatus}`,
    );

    // ========================================================================
    // 15. Request Body Size Protection
    // ========================================================================
    console.log('\n--- 15. Request Body Size Protection ---');
    // Send a payload exceeding general JSON parser or webhook limits (e.g. 1.2 MB)
    const largeBuffer = Buffer.alloc(1200 * 1024, 'a').toString();
    const oversizedRes = await request(server)
      .post(`/webhooks/simulator/${integrationSimulator.id}`)
      .set('Content-Type', 'application/json')
      .set('x-reloop-signature', 'dummy_sig')
      .send(JSON.stringify({ payload: largeBuffer }));

    recordResult(
      'Request Body Limit',
      'Oversized payload rejected safely with 413 Payload Too Large',
      oversizedRes.status === 413,
      `Received HTTP ${oversizedRes.status}`,
    );

    // ========================================================================
    // 16. Error Response Safety & Non-Leakage
    // ========================================================================
    console.log('\n--- 16. Error Response Safety & Non-Leakage ---');
    // Test synthetic 500 error through AllExceptionsFilter
    const mockResponseJson: any = {};
    const mockResponse: any = {
      status: (code: number) => {
        mockResponseJson.status = code;
        return {
          json: (body: any) => {
            mockResponseJson.body = body;
          },
        };
      },
    };

    const mockRequest: any = { method: 'POST', url: '/synthetic-test-error' };
    const mockHost: any = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    };

    const filter = new AllExceptionsFilter();
    // Simulate internal crash with sensitive internal details
    const secretLeakingError = new Error(
      'PrismaClientKnownRequestError: SELECT * FROM "users" WHERE "password" = \'secret_pass_123\' in /app/dist/server.js: DATABASE_URL=postgresql://reloop:supersecret@localhost:5433/reloop',
    );
    filter.catch(secretLeakingError, mockHost);

    const bodyStr = JSON.stringify(mockResponseJson.body || {});
    const leaksStackTrace = bodyStr.includes('/app/dist/server.js') || bodyStr.includes('Error:');
    const leaksPrisma = bodyStr.includes('PrismaClientKnownRequestError');
    const leaksSql = bodyStr.includes('SELECT * FROM');
    const leaksPassword = bodyStr.includes('secret_pass_123') || bodyStr.includes('supersecret');

    recordResult(
      'Error Response Safety',
      'Unhandled 500 error suppresses stack traces, SQL, Prisma internals, and secrets',
      mockResponseJson.status === 500 &&
        !leaksStackTrace &&
        !leaksPrisma &&
        !leaksSql &&
        !leaksPassword,
      `Status: ${mockResponseJson.status}, Stack trace leaked: ${leaksStackTrace}, SQL leaked: ${leaksSql}, Secrets leaked: ${leaksPassword}`,
    );

    // ========================================================================
    // 17. Health & Component Status
    // ========================================================================
    console.log('\n--- 17. Health & Component Status ---');
    const healthRes = await request(server).get('/health');
    const healthBody = healthRes.body;
    const hasComponents =
      healthBody?.components?.database?.status === 'ok' &&
      healthBody?.components?.redis?.status === 'ok';

    recordResult(
      'Health & Readiness',
      'GET /health reports service status and dependency health (database & redis)',
      healthRes.status === 200 && healthBody?.status === 'ok' && hasComponents,
      `Status: ${healthBody?.status}, DB: ${healthBody?.components?.database?.status}, Redis: ${healthBody?.components?.redis?.status}`,
    );

    // ========================================================================
    // 18. Production Configuration Fail-Fast
    // ========================================================================
    console.log('\n--- 18. Production Configuration Fail-Fast ---');
    // Test configuration factory without DATABASE_URL in production mode
    let dbFailFast = false;
    const origDbUrl = process.env.DATABASE_URL;
    const origNodeEnv = process.env.NODE_ENV;
    try {
      delete process.env.DATABASE_URL;
      process.env.NODE_ENV = 'production';
      configurationFactory();
    } catch (e: any) {
      if (e.message.includes('DATABASE_URL environment variable is required')) {
        dbFailFast = true;
      }
    } finally {
      process.env.DATABASE_URL = origDbUrl;
      process.env.NODE_ENV = origNodeEnv;
    }

    let keyFailFast = false;
    try {
      process.env.INTEGRATION_ENCRYPTION_KEY = 'invalid_short_key';
      configurationFactory();
    } catch (e: any) {
      if (e.message.includes('INTEGRATION_ENCRYPTION_KEY is invalid')) {
        keyFailFast = true;
      }
    } finally {
      process.env.INTEGRATION_ENCRYPTION_KEY =
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    }

    recordResult(
      'Configuration Fail-Fast',
      'Production configuration throws descriptive error when critical env vars are missing/invalid',
      dbFailFast && keyFailFast,
      `Missing DATABASE_URL caught: ${dbFailFast}, Invalid ENCRYPTION_KEY caught: ${keyFailFast}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    // Settle background webhook processors before closing
    await new Promise((r) => setTimeout(r, 600));
    await app.close();
    await prisma.$disconnect();
  }

  // ==========================================================================
  // Summary
  // ==========================================================================
  console.log('\n========================================================================');
  console.log('  SECURITY AUDIT MATRIX SUMMARY                                         ');
  console.log('========================================================================');
  const total = auditResults.length;
  const passed = auditResults.filter((r) => r.passed).length;
  const failed = total - passed;
  console.log(`Total Checks: ${total} | Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) {
    console.error('CRITICAL: One or more security assertions failed!');
    process.exit(1);
  } else {
    console.log(`SUCCESS: All ${total} security verification assertions PASSED.`);
  }
}

main().catch((err) => {
  console.error('Security audit matrix script error:', err);
  process.exit(1);
});
