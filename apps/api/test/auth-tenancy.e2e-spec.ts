import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Configuration error: TEST_DATABASE_URL environment variable is required for E2E tests.');
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as fs from 'fs';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Role } from '@reloop/database';
import { SecurityUtil } from '../src/auth/security.util';

function getCookies(res: request.Response): string[] {
  const c = res.headers['set-cookie'];
  if (Array.isArray(c)) return c;
  if (typeof c === 'string') return [c];
  return [];
}

describe('Authentication, Tenancy & Security E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
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

    // Clean test database before test suite
    await prisma.refreshSession.deleteMany({});
    await prisma.organizationMember.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});
  });

  afterAll(async () => {
    // Clean test database after test suite
    await prisma.refreshSession.deleteMany({});
    await prisma.organizationMember.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});
    await app.close();
  });

  describe('1. Registration Flow, Normalization & Projection', () => {
    it('POST /auth/register: registers User & Org, assigns OWNER, normalizes email, sets HttpOnly cookie', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Sarah Connor',
          email: '  Sarah.Normalized@Skynet-Defense.COM  ',
          password: 'Password123!',
          organizationName: 'Skynet Defense',
        })
        .expect(201);

      expect(response.body).toHaveProperty('accessToken');
      expect(response.body.user).toMatchObject({
        name: 'Sarah Connor',
        email: 'sarah.normalized@skynet-defense.com',
      });
      expect(response.body.organization).toMatchObject({
        name: 'Skynet Defense',
        slug: 'skynet-defense',
      });
      expect(response.body.role).toBe('OWNER');

      // Verify reloop_refresh cookie
      const cookies = getCookies(response);
      expect(cookies.length).toBeGreaterThan(0);
      const refreshCookie = cookies.find((c) => c.startsWith('reloop_refresh='));
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie).toContain('HttpOnly');
      expect(refreshCookie).toContain('Path=/auth');
    });

    it('Projection verification: register response never exposes password or passwordHash', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Projection User',
          email: 'projection@test.com',
          password: 'Password123!',
          organizationName: 'Projection Co',
        })
        .expect(201);

      expect(response.body).not.toHaveProperty('password');
      expect(response.body).not.toHaveProperty('passwordHash');
      expect(response.body.user).not.toHaveProperty('password');
      expect(response.body.user).not.toHaveProperty('passwordHash');
    });

    it('POST /auth/register: rejects duplicate email with 409 Conflict', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Sarah Duplicate',
          email: 'sarah.normalized@skynet-defense.com',
          password: 'AnotherPassword123!',
          organizationName: 'Another Org',
        })
        .expect(409);

      expect(response.body.message).toContain('already registered');
    });
  });

  describe('2. Login & Credential Verification', () => {
    it('POST /auth/login: succeeds with correct credentials and issues new session', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'sarah.normalized@skynet-defense.com',
          password: 'Password123!',
        })
        .expect(200);

      expect(response.body).toHaveProperty('accessToken');
      expect(response.body.user.email).toBe('sarah.normalized@skynet-defense.com');
      expect(response.body.role).toBe('OWNER');
      expect(response.body.user).not.toHaveProperty('password');
      expect(response.body.user).not.toHaveProperty('passwordHash');

      const cookies = getCookies(response);
      const refreshCookie = cookies.find((c) => c.startsWith('reloop_refresh='));
      expect(refreshCookie).toBeDefined();
    });

    it('POST /auth/login: rejects incorrect password with 401 Unauthorized', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'sarah.normalized@skynet-defense.com',
          password: 'WrongPassword!',
        })
        .expect(401);

      expect(response.body.message).toContain('Invalid email or password');
    });
  });

  describe('3. Refresh Token Rotation, Expiration & Replay Attack Prevention', () => {
    let initialCookie: string;
    let initialToken: string;

    beforeEach(async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'sarah.normalized@skynet-defense.com',
          password: 'Password123!',
        })
        .expect(200);

      initialToken = loginRes.body.accessToken;
      const cookies = getCookies(loginRes);
      initialCookie = cookies.find((c) => c.startsWith('reloop_refresh='))!.split(';')[0];
    });

    it('POST /auth/refresh: rotates session and returns a new access token', async () => {
      const refreshRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', [initialCookie])
        .expect(200);

      expect(refreshRes.body).toHaveProperty('accessToken');
      expect(refreshRes.body.accessToken).not.toBe(initialToken);

      const rotatedCookies = getCookies(refreshRes);
      const newCookie = rotatedCookies.find((c) => c.startsWith('reloop_refresh='))!.split(';')[0];
      expect(newCookie).not.toBe(initialCookie);

      // Attempting to reuse the old/rotated cookie must be rejected (replay attack prevention)
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', [initialCookie])
        .expect(401);
    });

    it('POST /auth/refresh: rejects expired refresh sessions with 401', async () => {
      // Modify session in database to be expired
      const sessionId = initialCookie.split('=')[1].split('.')[0];
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 2);

      await prisma.refreshSession.update({
        where: { id: sessionId },
        data: { expiresAt: pastDate },
      });

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', [initialCookie])
        .expect(401);
    });

    it('POST /auth/logout: revokes session and invalidates refresh token', async () => {
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Cookie', [initialCookie])
        .expect(200);

      // Subsequent refresh must fail
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', [initialCookie])
        .expect(401);
    });

    it('POST /auth/logout: is idempotent and safely succeeds on repeat calls', async () => {
      // First logout
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Cookie', [initialCookie])
        .expect(200);

      // Second logout with same/revoked cookie
      const res = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Cookie', [initialCookie])
        .expect(200);

      expect(res.body).toEqual({ success: true });

      // Logout with no cookie at all
      const resNoCookie = await request(app.getHttpServer())
        .post('/auth/logout')
        .expect(200);

      expect(resNoCookie.body).toEqual({ success: true });
    });
  });

  describe('4. /auth/me, Projection & Removed Membership', () => {
    it('GET /auth/me: returns 401 when unauthenticated', async () => {
      await request(app.getHttpServer()).get('/auth/me').expect(401);
    });

    it('GET /auth/me: returns safe user, org, and role when authenticated', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'sarah.normalized@skynet-defense.com',
          password: 'Password123!',
        })
        .expect(200);

      const meRes = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
        .expect(200);

      expect(meRes.body.user.email).toBe('sarah.normalized@skynet-defense.com');
      expect(meRes.body.organization.name).toBe('Skynet Defense');
      expect(meRes.body.role).toBe('OWNER');
      expect(meRes.body.user).not.toHaveProperty('password');
      expect(meRes.body.user).not.toHaveProperty('passwordHash');
    });

    it('GET /auth/me: rejects access if membership is deleted from database', async () => {
      // Register dedicated user to test membership revocation
      const regRes = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Revoked Member',
          email: 'revoked_member@test.com',
          password: 'Password123!',
          organizationName: 'Revoked Org',
        })
        .expect(201);

      const token = regRes.body.accessToken;
      const userId = regRes.body.user.id;
      const orgId = regRes.body.organization.id;

      // Delete the user organization membership in database
      await prisma.organizationMember.delete({
        where: {
          organizationId_userId: {
            organizationId: orgId,
            userId,
          },
        },
      });

      // Attempting to call /auth/me with valid JWT should now fail (authoritative DB check)
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });
  });

  describe('5. Multi-Tenant Isolation & IDOR Verification', () => {
    let orgAToken: string;
    let orgBToken: string;
    let orgAId: string;
    let orgBId: string;

    beforeAll(async () => {
      const regA = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Alice OrgA',
          email: 'alice@orga.com',
          password: 'Password123!',
          organizationName: 'Alpha Logistics',
        })
        .expect(201);
      orgAToken = regA.body.accessToken;
      orgAId = regA.body.organization.id;

      const regB = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Bob OrgB',
          email: 'bob@orgb.com',
          password: 'Password123!',
          organizationName: 'Beta Fulfillment',
        })
        .expect(201);
      orgBToken = regB.body.accessToken;
      orgBId = regB.body.organization.id;
    });

    it('GET /organizations/current: strictly returns the caller tenant data', async () => {
      const resA = await request(app.getHttpServer())
        .get('/organizations/current')
        .set('Authorization', `Bearer ${orgAToken}`)
        .expect(200);

      expect(resA.body.id).toBe(orgAId);
      expect(resA.body.name).toBe('Alpha Logistics');

      const resB = await request(app.getHttpServer())
        .get('/organizations/current')
        .set('Authorization', `Bearer ${orgBToken}`)
        .expect(200);

      expect(resB.body.id).toBe(orgBId);
      expect(resB.body.name).toBe('Beta Fulfillment');
    });

    it('GET /organizations/:organizationId: IDOR protection returns 200 for own org, 404 for other org', async () => {
      // Org A caller accesses Org A by ID -> 200
      const ownRes = await request(app.getHttpServer())
        .get(`/organizations/${orgAId}`)
        .set('Authorization', `Bearer ${orgAToken}`)
        .expect(200);

      expect(ownRes.body.id).toBe(orgAId);
      expect(ownRes.body.name).toBe('Alpha Logistics');

      // Org A caller attempts to access Org B by ID -> 404
      const foreignRes = await request(app.getHttpServer())
        .get(`/organizations/${orgBId}`)
        .set('Authorization', `Bearer ${orgAToken}`)
        .expect(404);

      // Must not leak any Org B data
      expect(foreignRes.body).not.toHaveProperty('name');
      expect(foreignRes.body).not.toHaveProperty('slug');
      expect(foreignRes.body.message).toContain('not found');
    });

    it('GET /organizations/current/members: returns only members belonging to the caller organization', async () => {
      const resA = await request(app.getHttpServer())
        .get('/organizations/current/members')
        .set('Authorization', `Bearer ${orgAToken}`)
        .expect(200);

      expect(resA.body).toHaveLength(1);
      expect(resA.body[0].email).toBe('alice@orga.com');

      const resB = await request(app.getHttpServer())
        .get('/organizations/current/members')
        .set('Authorization', `Bearer ${orgBToken}`)
        .expect(200);

      expect(resB.body).toHaveLength(1);
      expect(resB.body[0].email).toBe('bob@orgb.com');
    });

    it('PATCH /organizations/current: Org A updates Org A only, Org B is isolated and unchanged', async () => {
      await request(app.getHttpServer())
        .patch('/organizations/current')
        .set('Authorization', `Bearer ${orgAToken}`)
        .send({ name: 'Alpha Logistics Global' })
        .expect(200);

      const checkA = await request(app.getHttpServer())
        .get('/organizations/current')
        .set('Authorization', `Bearer ${orgAToken}`)
        .expect(200);
      expect(checkA.body.name).toBe('Alpha Logistics Global');

      const checkB = await request(app.getHttpServer())
        .get('/organizations/current')
        .set('Authorization', `Bearer ${orgBToken}`)
        .expect(200);
      expect(checkB.body.name).toBe('Beta Fulfillment');
    });
  });

  describe('6. Full RBAC Test Matrix (OWNER, ADMIN, OPERATOR, VIEWER)', () => {
    let ownerToken: string;
    let adminToken: string;
    let operatorToken: string;
    let viewerToken: string;
    let testOrgId: string;

    beforeAll(async () => {
      // Create owner & org
      const reg = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Owner User',
          email: 'rbac_matrix_owner@test.com',
          password: 'Password123!',
          organizationName: 'RBAC Matrix Org',
        })
        .expect(201);
      ownerToken = reg.body.accessToken;
      testOrgId = reg.body.organization.id;

      // Seed an ADMIN
      const adminHash = await SecurityUtil.hashPassword('Password123!');
      await prisma.user.create({
        data: {
          name: 'Admin User',
          email: 'rbac_matrix_admin@test.com',
          passwordHash: adminHash,
          memberships: {
            create: {
              organizationId: testOrgId,
              role: Role.ADMIN,
            },
          },
        },
      });

      const adminLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'rbac_matrix_admin@test.com',
          password: 'Password123!',
        })
        .expect(200);
      adminToken = adminLogin.body.accessToken;

      // Seed an OPERATOR
      const opHash = await SecurityUtil.hashPassword('Password123!');
      await prisma.user.create({
        data: {
          name: 'Operator User',
          email: 'rbac_matrix_operator@test.com',
          passwordHash: opHash,
          memberships: {
            create: {
              organizationId: testOrgId,
              role: Role.OPERATOR,
            },
          },
        },
      });

      const opLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'rbac_matrix_operator@test.com',
          password: 'Password123!',
        })
        .expect(200);
      operatorToken = opLogin.body.accessToken;

      // Seed a VIEWER
      const viewerHash = await SecurityUtil.hashPassword('Password123!');
      await prisma.user.create({
        data: {
          name: 'Viewer User',
          email: 'rbac_matrix_viewer@test.com',
          passwordHash: viewerHash,
          memberships: {
            create: {
              organizationId: testOrgId,
              role: Role.VIEWER,
            },
          },
        },
      });

      const viewerLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'rbac_matrix_viewer@test.com',
          password: 'Password123!',
        })
        .expect(200);
      viewerToken = viewerLogin.body.accessToken;
    });

    it('VIEWER role is forbidden (403) from updating organization settings', async () => {
      await request(app.getHttpServer())
        .patch('/organizations/current')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ name: 'Malicious Update by Viewer' })
        .expect(403);
    });

    it('OPERATOR role is forbidden (403) from updating organization settings', async () => {
      await request(app.getHttpServer())
        .patch('/organizations/current')
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ name: 'Malicious Update by Operator' })
        .expect(403);
    });

    it('ADMIN role is authorized (200) to update organization settings', async () => {
      const res = await request(app.getHttpServer())
        .patch('/organizations/current')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'RBAC Matrix Org - Updated by Admin' })
        .expect(200);

      expect(res.body.name).toBe('RBAC Matrix Org - Updated by Admin');
    });

    it('OWNER role is authorized (200) to update organization settings', async () => {
      const res = await request(app.getHttpServer())
        .patch('/organizations/current')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'RBAC Matrix Org - Updated by Owner' })
        .expect(200);

      expect(res.body.name).toBe('RBAC Matrix Org - Updated by Owner');
    });
  });

  describe('7. Origin / CSRF Protection', () => {
    it('rejects state-changing requests with mismatched Origin header with 403', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .set('Origin', 'https://malicious-attacker.com')
        .send({
          name: 'Attacker',
          email: 'attacker@evil.com',
          password: 'Password123!',
          organizationName: 'Evil Corp',
        })
        .expect(403);
    });

    it('allows requests with configured frontend Origin', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .set('Origin', 'http://localhost:3100')
        .send({
          name: 'Legit User',
          email: 'legit_origin@test.com',
          password: 'Password123!',
          organizationName: 'Legit Corp',
        })
        .expect(201);
    });
  });

  describe('8. Auth Rate Limiting Proof (HTTP 429)', () => {
    it('repeated requests to auth endpoints eventually receive HTTP 429 Too Many Requests', async () => {
      // Limit is 10 requests per minute. Send 12 requests.
      let got429 = false;

      for (let i = 0; i < 12; i++) {
        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({
            email: 'nonexistent@test.com',
            password: 'BadPassword!',
          });

        if (res.status === 429) {
          got429 = true;
          break;
        }
      }

      expect(got429).toBe(true);
    });
  });

  describe('9. Frontend Zero-Storage Verification', () => {
    it('verifies frontend code does not store tokens in localStorage, sessionStorage, or IndexedDB', () => {
      const webSrcPath = path.resolve(__dirname, '../../web/src');
      const files: string[] = [];

      function collectFiles(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            collectFiles(fullPath);
          } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
            files.push(fullPath);
          }
        }
      }

      collectFiles(webSrcPath);

      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        expect(content).not.toMatch(/localStorage\.setItem/);
        expect(content).not.toMatch(/sessionStorage\.setItem/);
        expect(content).not.toMatch(/indexedDB\.open/);
      }
    });
  });
});