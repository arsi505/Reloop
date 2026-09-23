# Reloop Security Architecture & Threat Model

This document specifies the security architecture, controls, threat model, and defense-in-depth mechanisms implemented in Reloop.

---

## 1. Authentication & Session Management

### 1.1 Credential Storage & Password Hashing
- **Algorithm**: Argon2id via `argon2` library.
- **Parameters**: Uses Argon2id password hashing with recommended memory and time cost parameters.
- **Salts**: Cryptographically random, unique salt generated per password automatically by Argon2id.
- **Projection Safety**: User queries strictly omit `passwordHash`. Responses never serialize or return password hashes to API clients or logs.

### 1.2 Access & Refresh Token Architecture
- **Dual-Token System**:
  - **Access Token**: Short-lived JSON Web Token (JWT) with 15-minute expiration. Intended to be held strictly in volatile memory by the frontend client (never placed in `localStorage`). Contains `userId`, `organizationId`, `role`, and `email`.
  - **Refresh Token**: High-entropy cryptographically random string (32 bytes). Persisted exclusively as an `HttpOnly`, `SameSite=Lax` cookie (`reloop_refresh`) scoped to the `/auth` path.
- **Database Session Tracking**: Every issued refresh token is hashed with SHA-256 and stored in the `refresh_sessions` table with an expiration timestamp (`expires_at`), last used timestamp (`last_used_at`), and optional revocation timestamp (`revoked_at`).

### 1.3 Refresh Token Rotation & CAS Replay Protection
- **Compare-And-Swap (CAS) Rotation**: When a client requests a new access token via `POST /auth/refresh`, the database atomically updates the session record matching `tokenHash = currentHash` and `revokedAt IS NULL`, replacing it with the new token hash.
- **Replay & Hijack Detection**: If an already-rotated or revoked refresh token is presented again, the CAS update matches zero rows. The system flags a potential token replay attack, immediately rejects the request with `401 Unauthorized` (`Refresh token rotation conflict: token already rotated or revoked`), and invalidates the session family.
- **Explicit Logout**: `POST /auth/logout` sets `revoked_at = NOW()` on the session record and issues a `Set-Cookie` header clearing `reloop_refresh` (Max-Age=0). Any subsequent attempt to use the revoked refresh token is rejected with `401 Unauthorized`.

---

## 2. Multi-Tenant Isolation

### 2.1 Logical Isolation at Data Layer
Reloop implements shared-database, shared-schema logical multi-tenancy. Every tenant-scoped entity in the PostgreSQL database contains an indexed `organization_id` foreign key referencing the `organizations` table:
- `integrations`
- `recovery_cases`
- `workflows`
- `workflow_steps`
- `jobs`
- `approvals`
- `audit_logs`
- `external_orders`
- `external_references`
- `integration_events`
- `refresh_sessions`

### 2.2 Application-Layer Scoping
- **Token-Bound Authority**: The user's active tenant authority is extracted exclusively from the cryptographically verified JWT payload (`user.organizationId`) via NestJS `@CurrentUser()` decorator. Clients cannot override tenant scope via headers or URL parameters.
- **Scoped Service Operations**: Every database query in business services explicitly scopes by `organizationId`:
  ```typescript
  await this.prisma.approval.findFirst({
    where: { id: approvalId, organizationId: user.organizationId },
  });
  ```
- **Information Leakage Prevention**: Requests attempting to query or mutate an entity belonging to another organization receive `404 Not Found` (or `403 Forbidden`). Error responses do not disclose whether the entity exists in a different tenant.

### 2.3 Realtime WebSocket Tenant Isolation
- **Socket Authentication**: Realtime WebSocket connections (`/socket.io`) require a valid JWT passed in the auth payload (`client.handshake.auth.token`) or `Authorization: Bearer <token>` header during handshake. Passing authentication tokens in query strings is strictly rejected to prevent secret leakage in access logs.
- **Room Sandboxing**: Sockets are bound strictly to rooms named `org:<organizationId>`. Event broadcasts are emitted to the specific tenant's room using strictly typed event names (`exception.created`, `exception.updated`, `recovery.created`, `recovery.updated`, `recovery.approval_requested`, `recovery.approval_decided`, `recovery.verification_updated`, `integration.health_changed`, `integration.sync_completed`, `integration.sync_failed`, `order.updated`, `dashboard.changed`) and the consolidated invalidation envelopes (`realtime:event`, `realtime.event`). No fabricated event names are emitted.

---

## 3. Role-Based Access Control (RBAC)

Reloop enforces a 4-tier Role-Based Access Control model defined by the `Role` enum:

| Capability | OWNER | ADMIN | OPERATOR | VIEWER |
| :--- | :---: | :---: | :---: | :---: |
| View Dashboards & Recovery Cases | Allowed | Allowed | Allowed | Allowed |
| View Approvals & Integration Status | Allowed | Allowed | Allowed | Allowed |
| Execute Approvals (`/approvals/:id/approve`) | Allowed | Allowed | Allowed | **Forbidden (403)** |
| Reject Approvals (`/approvals/:id/reject`) | Allowed | Allowed | Allowed | **Forbidden (403)** |
| Trigger Manual Re-sync / Retry Jobs | Allowed | Allowed | Allowed | **Forbidden (403)** |
| Connect / Modify Integrations | Allowed | Allowed | **Forbidden (403)** | **Forbidden (403)** |
| Disconnect Integrations | Allowed | Allowed | **Forbidden (403)** | **Forbidden (403)** |
| Invite / Manage Organization Members | Allowed | Allowed | **Forbidden (403)** | **Forbidden (403)** |
| Delete Organization / Transfer Ownership | Allowed | **Forbidden (403)** | **Forbidden (403)** | **Forbidden (403)** |

### Dual-Gate Guard Enforcement
Routes requiring specific permissions combine `JwtAuthGuard` and `RolesGuard`:
```typescript
@Post(':id/approve')
@UseGuards(RolesGuard)
@Roles('OWNER', 'ADMIN', 'OPERATOR')
async approve(...) { ... }
```
Any caller possessing the `VIEWER` role attempting to execute mutations is rejected with `403 Forbidden`.

---

## 4. CSRF & CORS Defenses

### 4.1 CORS Whitelisting
- **Strict Allowed Origins**: CORS configuration in `main.ts` restricts origins strictly to the configured frontend URL (`process.env.FRONTEND_URL || 'http://localhost:3100'`).
- **No Wildcards**: Wildcard origins (`*`) are disallowed when `credentials: true` is enabled.
- **Method Restrictions**: Whitelisted to standard REST verbs (`GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS`).

### 4.2 CSRF Mitigations
- **Cookie SameSite Policy**: The refresh cookie is served with `SameSite=Lax`, preventing cross-site transmission during cross-origin subresource requests.
- **OriginGuard**: State-changing authentication endpoints (`POST /auth/logout`, `POST /auth/refresh`) validate the incoming `Origin` header against the authorized frontend origin when present.
- **Security Response Headers**:
  - `X-Content-Type-Options: nosniff` (prevents MIME sniffing)
  - `X-Frame-Options: DENY` (prevents clickjacking attacks)
  - `Referrer-Policy: strict-origin-when-cross-origin` (prevents referrer leakage)

---

## 5. Webhook Security Architecture

### 5.1 Constant-Time HMAC Signature Verification
All inbound webhook payloads must be accompanied by a valid cryptographic HMAC signature:
- **Shopify**: SHA-256 HMAC sent via `x-shopify-hmac-sha256` header.
- **Simulator / Generic**: SHA-256 HMAC sent via `x-reloop-signature` header.
- **Constant-Time Verification**: Verification is performed using `crypto.timingSafeEqual`:
  ```typescript
  const expectedBuf = Buffer.from(computedHex, 'utf8');
  const actualBuf = Buffer.from(signatureHex, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
  ```
  This eliminates timing side-channel attacks that attempt to reconstruct secret signatures.

### 5.2 Raw Body Preservation
Because JSON parsers can re-order object keys or alter whitespace, verifying HMAC against a re-serialized object causes false signature failures. Reloop preserves the byte-exact payload via NestJS `rawBody: true` during bootstrap. Signature verification is performed directly against the raw byte buffer.

### 5.3 Deduplication & Replay Safety
To prevent duplicate processing caused by network retries or replay attacks:
1. Every inbound webhook requires a unique provider delivery identifier (`x-reloop-event-id`, `x-shopify-webhook-id`).
2. The database enforces a unique compound index: `@@unique([integrationId, providerEventId])` on `integration_events`.
3. If an identical `providerEventId` is received for an integration, Reloop immediately returns HTTP 200 `{ status: 'ignored_duplicate' }` without queuing duplicate background jobs or executing business mutations.

### 5.4 Payload Size Ceiling
Webhook ingestion is protected against memory exhaustion and denial-of-service via an explicit payload size ceiling (default 1 MB, configured via `WEBHOOK_MAX_PAYLOAD_BYTES`). Payloads exceeding this threshold are immediately rejected with `413 Payload Too Large`.

---

## 6. Integration & OAuth Security

### 6.1 Shopify OAuth 2.0 Flow
1. **SSRF Domain Validation**: Prior to initiating connection, the user-supplied shop domain is validated by `normalizeAndValidateShopDomain`:
   - Strips protocol and trailing slashes.
   - Rejects IP addresses (e.g. `127.0.0.1`, `169.254.169.254`), path components, port numbers, queries, fragments, or credentials.
   - Strictly enforces the canonical regex: `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$`.
2. **Cryptographic State Parameter**:
   - Generates a 32-byte cryptographically secure random string via `crypto.randomBytes(32).toString('hex')`.
   - Persisted in the `oauth_states` table with `expiresAt = NOW() + 10 minutes`.
3. **Single-Use Atomic State Consumption**:
   - During callback verification, the state is verified and atomically marked consumed:
     ```typescript
     const updateResult = await this.prisma.oAuthState.updateMany({
       where: { state, usedAt: null },
       data: { usedAt: new Date() },
     });
     ```
   - If `updateResult.count === 0`, the callback is rejected with `400 Bad Request` (`OAuth state was already consumed`). This prevents concurrent state replay attacks.
4. **Callback HMAC Validation**: Query parameters returned by Shopify are sorted and verified with constant-time HMAC comparison before exchanging the authorization code.

### 6.2 Egress & Outbound Destination Safety
- **ShipStation Egress**: The ShipStation connector communicates exclusively with the immutable upstream base endpoint `https://api.shipstation.com/v2`. The base URL cannot be manipulated via user input or database configuration, completely mitigating server-side request forgery (SSRF) during shipping operations.

---

## 7. Cryptographic Envelope Encryption at Rest

Sensitive third-party credentials (OAuth access tokens, API secrets, webhook signing keys) are encrypted before persistence in PostgreSQL.

### 7.1 Encryption Specification
- **Algorithm**: AES-256-GCM (Authenticated Encryption with Associated Data).
- **Master Key**: 256-bit key provided via `INTEGRATION_ENCRYPTION_KEY` environment variable. Never persisted to the database.
- **Initialization Vector (IV)**: Cryptographically random 12-byte IV generated uniquely per encryption operation via `crypto.randomBytes(12)`.
- **Authentication Tag**: 16-byte GCM authentication tag generated by the cipher.
- **Envelope Structure**:
  ```json
  {
    "version": 1,
    "algorithm": "aes-256-gcm",
    "keyId": "v1",
    "iv": "<base64-encoded-12-bytes>",
    "tag": "<base64-encoded-16-bytes>",
    "ciphertext": "<base64-encoded-ciphertext>"
  }
  ```

### 7.2 Integrity & Tamper Detection
During decryption (`decryptCredentials`), `decipher.setAuthTag()` is invoked. If the ciphertext, IV, or authentication tag has been tampered with or corrupted, `decipher.final()` fails and throws `EncryptionError`. Plaintext credentials are never exposed if authentication validation fails.

---

## 8. Secret Management & Log Redaction

### 8.1 Zero Tracked Secrets
Version control contains zero production secrets:
- `.env` files are excluded in `.gitignore`.
- Only `.env.example` is tracked, containing placeholder strings (`change_me`).
- Docker Compose configuration utilizes environment variable substitution (`${POSTGRES_PASSWORD}`).

### 8.2 Log & Error Sanitization
Error messages from job execution and database operations pass through `sanitizeErrorMessage` before being persisted in `job_attempts` or logged to `stdout`:
- Database connection strings with embedded credentials (`postgresql://user:pass@host:port/db`) are replaced with `postgresql://[REDACTED]@host:port/db`.
- Redis connection strings (`redis://user:pass@host:port`) are replaced with `redis://[REDACTED]@host:port`.
- Bearer tokens (`Bearer <token>`) are replaced with `Bearer [REDACTED]`.
- Key-value credentials (`password=...`, `token=...`, `secret=...`, `key=...`) are replaced with `key=[REDACTED]`.
- Error messages are truncated to 500 characters to prevent log buffer overflow.

### 8.3 Global Exception Filtering
The NestJS API registers `AllExceptionsFilter`. Unhandled runtime exceptions caught by the framework return a uniform, sanitized error payload:
```json
{
  "statusCode": 500,
  "timestamp": "2026-09-23T15:00:00.000Z",
  "path": "/api/v1/resource",
  "error": { "message": "Internal server error" }
}
```
Internal stack traces and database error details are never exposed to external clients.

---

## 9. Input Validation & Mass Assignment Defenses

### 9.1 Whitelist Enforcement
The API applies a global `ValidationPipe` with strict security options:
```typescript
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
);
```
- **`whitelist: true`**: Automatically strips any properties not present in the target Data Transfer Object (DTO).
- **`forbidNonWhitelisted: true`**: If an incoming request body contains undeclared properties, the request is immediately rejected with `400 Bad Request` (`property <name> should not exist`). This defends against mass-assignment and property injection attacks (e.g. attempting to inject `isAdmin: true` or `role: OWNER`).

---

## 10. Rate Limiting & Denial-of-Service Mitigations

### 10.1 Tiered Throttling
Reloop uses `@nestjs/throttler` with a globally registered `APP_GUARD`:
- **Default Tier**: 100 requests per minute per IP address for standard API endpoints.
- **Auth Tier**: 10 requests per minute per IP address for authentication endpoints (`/auth/login`, `/auth/register`) to mitigate credential stuffing and brute-force password attacks.

---

## 11. Security Audit Matrix Verification

The security controls documented above are continuously verified by the automated audit suite `scripts/reliability/security-audit-matrix.ts` across 41 granular checks:
1. `Authentication`: Unauthenticated request to protected route rejected (HTTP 401).
2. `Authentication`: Authenticated user receives valid JWT access token and claims.
3. `Authentication`: Refresh cookie emitted with HttpOnly, SameSite=Lax, and Path=/auth.
4. `Tenant Isolation`: Cross-tenant approval lookup returns HTTP 404 (no leak).
5. `Tenant Isolation`: Cross-tenant approval mutation returns HTTP 404 (no leak).
6. `Tenant Isolation`: Cross-tenant integration access returns HTTP 404 (no leak).
7. `RBAC`: OWNER role permitted to approve (HTTP 200).
8. `RBAC`: ADMIN role permitted to approve (HTTP 200).
9. `RBAC`: OPERATOR role permitted to approve (HTTP 200).
10. `RBAC`: OWNER role permitted to connect integration (HTTP 200/201).
11. `RBAC`: OPERATOR role forbidden from connecting integrations (HTTP 403).
12. `RBAC`: OPERATOR role forbidden from replacing credentials (HTTP 403).
13. `RBAC`: VIEWER role forbidden from connecting integrations (HTTP 403).
14. `RBAC`: VIEWER role forbidden from disconnecting integrations (HTTP 403).
15. `Session Security`: Refresh token CAS rotation succeeds and issues new cookie.
16. `Session Security`: Replayed old refresh token strictly rejected with 401 (rotation conflict).
17. `Session Security`: Logout invalidates session and clears cookie.
18. `Session Security`: Refresh after logout strictly rejected with 401.
19. `CSRF Defenses`: State-changing auth endpoint with untrusted Origin rejected with 403.
20. `CSRF Defenses`: Logout with untrusted Origin rejected with 403.
21. `Webhook Security`: Missing HMAC signature rejected with 401.
22. `Webhook Security`: Invalid HMAC signature rejected with 401.
23. `Webhook Security`: Valid HMAC signature accepted with 200 (accepted).
24. `Webhook Security`: Provider-event deduplication acknowledges replay as ignored_duplicate.
25. `OAuth Security`: Valid OAuth state consumed once successfully.
26. `OAuth Security`: Replayed OAuth state strictly rejected with 400.
27. `OAuth Security`: Expired OAuth state strictly rejected with 400.
28. `OAuth Security`: OAuth state bound to wrong shop domain rejected with 400.
29. `SSRF Prevention`: Rejects all malicious/internal SSRF patterns and normalizes canonical domain.
30. `Encryption`: Decryption with different key B fails safely without plaintext leakage.
31. `Encryption`: Tampered ciphertext and authentication tag trigger EncryptionError.
32. `Encryption`: Invalid key format fails safely (does not fall back to plaintext).
33. `Secret Redaction`: Sanitizes DB connection strings, passwords, tokens, and Bearer headers.
34. `Input Validation`: Global ValidationPipe rejects non-whitelisted properties with 400.
35. `CORS Security`: Configured trusted frontend origin reflected with credentials allowed.
36. `CORS Security`: Arbitrary untrusted origin is strictly NOT allowed.
37. `Rate Limiting`: Repeated login attempts trigger HTTP 429 Too Many Requests.
38. `Request Body Limit`: Oversized payload rejected safely with 413 Payload Too Large.
39. `Error Response Safety`: Unhandled 500 error suppresses stack traces, SQL, Prisma internals, and secrets.
40. `Health & Readiness`: GET /health reports service status and dependency health (database & redis).
41. `Configuration Fail-Fast`: Production configuration throws descriptive error when critical env vars are missing/invalid.

---

## 12. Known Limitations & Operational Boundary

1. **Dependency Constraints & Security Remediation**:
   - `@reloop/web` has been remediated and upgraded to `next@15.5.24` and `eslint-config-next@15.5.24` under React 18, eliminating all critical Next.js advisories (`GHSA-p293-qw3h-jr36`, `GHSA-2xp9-vwfh-vxw4`, `GHSA-f82v-jwr5-mffw`) and resulting in 0 critical audit vulnerabilities. The core backend API (`@reloop/api`) and background worker pool (`@reloop/worker`) execute independently on NestJS and Node.js without Next.js server runtime. Remaining high findings consist of build/dev-time tools (PostCSS, deepmerge-ts, Prisma CLI) and unused transitive paths (multer without upload endpoints, lodash without template evaluation).
2. **Health Endpoints**:
   - Reloop provides a single unified `/health` endpoint reporting overall status, database connection, and Redis connection. Separate dedicated `/ready` and `/live` endpoints are not currently exposed.
3. **Transport Security (HTTPS / WSS)**:
   - Reloop services listen on HTTP/WS internally. Production deployments MUST sit behind an SSL-terminating reverse proxy or API gateway (e.g. Cloudflare, Nginx, AWS ALB) enforcing HTTPS and WSS. The `reloop_refresh` cookie enables the `Secure` flag conditionally when `NODE_ENV === 'production'`.
4. **Data Durability & Redis Scope**:
   - PostgreSQL is the single durable source of truth. Redis holds volatile queues, caches, and Socket.io pub/sub messages. In the event of catastrophic Redis data loss, workflow and job states can be reconstructed from PostgreSQL `jobs` and `integration_events`.
5. **Deployment Topology Scope**:
   - Reloop is packaged and verified for single-region multi-container Docker Compose / VM environments. No claims are made regarding Kubernetes multi-cluster federation, active-active cross-region database replication, or distributed consensus.
