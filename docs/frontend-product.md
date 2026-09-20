# Reloop Frontend Product Architecture (Day 18)

## 1. Executive Summary & Design System

The Reloop frontend product UI translates the core backend reliability and recovery engine into an intuitive, high-density, b2b operational interface. Designed according to the locked visual reference (`docs/design/reloop-ui-reference.png`), the interface conveys operational control and enterprise reliability without decorative gradients or generic AI hype.

### 1.1 Visual Identity & Palette
- **Application Background:** Warm off-white / ivory (`#fbfbfa`, `#F8F8F6`).
- **Content Surfaces:** Pure white (`#ffffff`) card containers with subtle 1px border (`#ececeb`).
- **Typography:** Near-black / graphite (`#18181b` headers, `#27272a` body, `#71717a` muted metadata, `#a1a1aa` uppercase section labels).
- **Brand Accent:** Restrained orange (`#f95721`, `#ea580c`) used exclusively for active navigation markers, brand logo, and focus states.
- **Semantic Badges:** Small restrained status badges with muted backgrounds and precise dot indicators (`#10b981` emerald for healthy/succeeded, `#f59e0b` amber for waiting/require approval, `#ef4444` rose for blocked/failed, `#6366f1` indigo for auto-recovering, `#71717a` zinc for pending/neutral).
- **Responsive Layout:** 64-column fixed sidebar on desktop (>=768px), fluid adaptive main pane, slide-over drawer navigation with backdrop blur for mobile (<768px).

---

## 2. Page Architecture & Stable Routes

All pages are top-level Next.js 14 App Router pages under `apps/web/src/app`. Every page supports direct URL access, bookmarking, browser back/forward navigation, and client-side query string synchronization.

### 2.1 Route Map
1. **`/dashboard`**: Primary operations hub showing live high-level reliability metrics, active exception preview table, system connection states, and recovery distribution.
2. **`/exceptions`**: High-density operational queue for incident investigation with server-side pagination, debounced search (300ms), and multi-filter coordination (`status`, `recoveryLevel`, `type`, `provider`).
3. **`/exceptions/[id]`**: Deep-linkable exception detail page with incident summary, logical order link, provider source integration, operator approval request preview, workflow execution step tree, and collapsed sanitized technical evidence.
4. **`/orders`**: Cross-system orders explorer comparing Shopify commercial intent with ShipStation physical fulfillment records. Supports server-side pagination, search, status, and discrepancy filtering.
5. **`/orders/[id]`**: Deep-linkable order comparison page detailing side-by-side Shopify state vs ShipStation shipment/label records, cross-system discrepancies, related active exceptions, and external identifiers.
6. **`/login` & `/register`**: Tenant authentication routes with session establishment and refresh token rotation.
7. **`/app`**: Route redirector forwarding authenticated operators to `/dashboard`.

---

## 3. Component Hierarchy & Modular Architecture

### 3.1 Layout & Shell
- `AppShell` (`apps/web/src/components/layout/AppShell.tsx`):
  - Sticky sidebar with brand logo, organization switcher, primary operations navigation, secondary configuration links, and user session menu.
  - Header with breadcrumbs, global search bar, notification indicators, and user avatar.
  - Mobile slide-over drawer activated by hamburger button on narrow viewports.

### 3.2 UI Primitives
- `StatusBadge` (`apps/web/src/components/ui/StatusBadge.tsx`): Normalized status indicator for workflows, approvals, orders, integrations, and recovery levels.
- `Skeleton` (`apps/web/src/components/ui/Skeleton.tsx`): Restrained skeleton loaders (`MetricCardSkeleton`, `TableRowSkeleton`) preventing layout shifts.
- `ErrorState` (`apps/web/src/components/ui/ErrorState.tsx`): Contextual error banner supporting 401 Unauthorized, 403 Forbidden, 404 Not Found, and 500 Network errors with interactive retry.
- `EmptyState` (`apps/web/src/components/ui/EmptyState.tsx`): Informative empty state for zero-records or unmatched search filters.
- `Icons` (`apps/web/src/components/icons/Icons.tsx`): Custom crisp SVG icons for navigation, providers (Shopify, ShipStation), status indicators, and actions.

### 3.3 Operations Components
- `DashboardView` (`apps/web/src/components/operations/DashboardView.tsx`): Real metrics from `GET /dashboard/summary`, queue preview, recent recoveries, connected systems health.
- `ExceptionsView` (`apps/web/src/components/operations/ExceptionsView.tsx`): Filterable, searchable table consuming `GET /exceptions` with URL synchronization.
- `ExceptionDetailView` (`apps/web/src/components/operations/ExceptionDetailView.tsx`): Comprehensive investigation view consuming `GET /exceptions/:id`.
- `OrdersView` (`apps/web/src/components/operations/OrdersView.tsx`): Unified orders table consuming `GET /orders`.
- `OrderDetailView` (`apps/web/src/components/operations/OrderDetailView.tsx`): Side-by-side reconciliation comparison consuming `GET /orders/:id`.

---

## 4. API Client & Contracts Integration

### 4.1 Strict Domain Typing
The frontend imports contracts directly from `@reloop/contracts`:
- `DashboardSummaryDto`
- `ExceptionListItemDto`, `ExceptionDetailDto`, `ExceptionQueryDto`
- `OrderListItemDto`, `OrderDetailDto`, `OrderQueryDto`
- `RecoveryListItemDto`, `RecoveryDetailDto`
- `IntegrationCardDto`, `IntegrationDetailDto`

### 4.2 Query String Synchronization & Debouncing
- Search input values are debounced by 300ms using `useDebounce` to prevent API thrashing.
- Query parameters (`page`, `pageSize`, `search`, `status`, `provider`, `recoveryLevel`, `hasException`) are synchronized to Next.js URL query params via `router.push(..., { scroll: false })`.
- Bookmarkable URLs restore exact filter and pagination state on reload.

### 4.3 Network Efficiency & Anti-N+1 Guarantee
- Detail endpoints (`/exceptions/:id`, `/orders/:id`) are strictly isolated to detail views. List views consume lightweight list DTOs only.
- Direct single-trip batch queries on list pages eliminate N+1 API cascades.

---

## 5. Security & Privacy Guarantees

1. **Zero Customer PII:**
   - No customer names, phone numbers, personal emails, or shipping addresses are rendered or exposed in client bundles, tables, or detail cards.
   - All diagnostic payloads are sanitized server-side (`sanitizedEvidence`) and client-side before display.
2. **Safe Credential Management:**
   - JWT access tokens are stored strictly in-memory (`inMemoryAccessToken`) and never in `localStorage`, `sessionStorage`, or `IndexedDB`.
   - Refresh tokens are transmitted exclusively via `reloop_refresh` HttpOnly, SameSite cookies with automatic silent renewal on 401 response.
3. **Execution Guardrails:**
   - Read-only protection: Blocked exceptions and approval gates show policy warnings and previews without executing unverified state mutations.
   - Preserves Day 16 ShipStation semantics: ShipStation records represent shipment & label entities rather than authoritative physical delivery.

---

## 6. Recoveries, Approval Interactions & Integrations (Day 19)

### 6.1 Recoveries Queue (`/recoveries`)
- **Route:** `apps/web/src/app/recoveries/page.tsx`
- **Component:** `RecoveriesView` (`apps/web/src/components/operations/RecoveriesView.tsx`)
- Consumes `GET /recoveries` with server-side pagination, 300ms debounced search, `status`, and `recoveryLevel` filters.
- Displays case identifiers, logical order links, problem summary, template key with version, recovery level badge, approval status badge, workflow status badge, start/completion times, and direct link to Flight Recorder.

### 6.2 Recovery Flight Recorder & Durable Timeline (`/recoveries/[id]`)
- **Route:** `apps/web/src/app/recoveries/[id]/page.tsx`
- **Component:** `RecoveryDetailView` (`apps/web/src/components/operations/RecoveryDetailView.tsx`) & `FlightRecorderTimeline` (`apps/web/src/components/operations/FlightRecorderTimeline.tsx`)
- Consumes `GET /recoveries/:id`.
- Problem summary banner, duration badge, associated external order link.
- **Flight Recorder Timeline:**
  - Consumes durable backend `timeline: TimelineEntryDto[]` without synthesising client events.
  - Visually distinguishes phase types: `CHECK` (indigo), `EXECUTE` (amber), `VERIFY` (teal/emerald).
  - Explicitly separates execution success from verification success (a successful API push is distinct from post-mutation verification confirmation).
  - Verified Resolution card renders when verification succeeds; alerts render when verification fails.
  - Collapsible event metadata disclosures display structured system/actor audit context.
  - Automatically polls every 4 seconds when workflow status is `RUNNING` or `WAITING`.

### 6.3 Operator Approval & Rejection Interactions
- **Component:** `ApprovalPanel` (`apps/web/src/components/operations/ApprovalPanel.tsx`)
- Reusable across both Recovery Detail (`/recoveries/[id]`) and Exception Detail (`/exceptions/[id]`).
- **Immutable Preview Snapshot:** Renders proposed mutations, target systems, rationale, and non-changes safely from immutable backend snapshots.
- **Role Gating:**
  - `OWNER`, `ADMIN`, and `OPERATOR` roles are permitted to decide approvals.
  - `VIEWER` role is presented with a read-only policy explanation notice and decision controls are disabled/hidden.
- **Approve Flow:**
  - Accessible via "Approve Recovery" button.
  - Modal with clear explanation of downstream execution impact.
  - Optional operator context/audit note.
  - Dispatches `POST /approvals/:id/approve` with double-submit protection.
- **Reject Flow:**
  - Accessible via "Reject Recovery" button.
  - Modal requiring an explicit rejection reason (enforced with client and server validation).
  - Permanent workflow halt notice: halts workflow, transitions step to terminal, prevents downstream mutations.
  - Dispatches `POST /approvals/:id/reject`.
- **409 Conflict Handling:**
  - If another operator or worker already decided or transitioned the approval, a clear amber notification banner is rendered (`"Approval State Updated: This approval has already been decided by another operator or is no longer pending."`).
  - Automatically triggers state refetch to synchronize authoritative backend data without full page reload.

### 6.4 Integrations Hub & Provider Management (`/integrations`)
- **Route:** `apps/web/src/app/integrations/page.tsx`
- **Component:** `IntegrationsView` (`apps/web/src/components/operations/IntegrationsView.tsx`)
- Consumes `GET /integrations`.
- Displays connected providers (Shopify, ShipStation) with health badges (`HEALTHY`, `DEGRADED`, `DISCONNECTED`, `SYNCING`), safe account identifiers, read-only mode tags, last sync timestamps, and sanitized error summaries.
- **Connect Shopify Modal:**
  - Validates canonical domain format (rejecting paths, ports, IPs, or non-Shopify domains).
  - Dispatches `POST /integrations/shopify/connect` and redirects to provider OAuth flow.
- **Connect ShipStation Modal:**
  - Password-masked input field for API Key.
  - Key is sent directly via `POST /integrations/shipstation/connect` and cleared immediately from memory upon submission. Zero plaintext persistence in browser storage.
- **Replace ShipStation Key Modal:**
  - Allows credential rotation via `POST /integrations/shipstation/:id/credentials/replace`.
- **Disconnect Modal:**
  - Explains that past synchronization history, audit logs, and recovery cases are permanently retained.
  - Dispatches `POST /integrations/:id/disconnect`.

### 6.5 Integration Detail View (`/integrations/[id]`)
- **Route:** `apps/web/src/app/integrations/[id]/page.tsx`
- **Component:** `IntegrationDetailView` (`apps/web/src/components/operations/IntegrationDetailView.tsx`)
- Consumes `GET /integrations/:id`.
- 4-stat metric overview (last sync, active incidents, historical cases, capability boundary).
- Recent synchronization jobs table showing job type, status, attempts, enqueued, and completed timestamps.
- Safe configuration viewer rendering sanitized scopes, store domain, and sync intervals without leaking secrets.

### 6.6 System Health Dashboard (`/health`)
- **Route:** `apps/web/src/app/health/page.tsx`
- **Component:** `HealthView` (`apps/web/src/components/operations/HealthView.tsx`)
- Consumes real backend adapter statuses and sync health metrics from `GET /integrations` and `GET /dashboard/summary`.
- Operational metrics cards (Total Integrations, Healthy Adapters, Degraded Adapters, Safety Guardrails).
- Real-time provider adapter connectivity and rate-limiting status table with deep-links to integration inspection views.

---

## 7. Realtime Operations & Product Polish (Day 20)

### 7.1 Realtime Operations Philosophy & Signals Model
- **Invalidation Only:** WebSockets in Reloop transmit lightweight change notifications (`RealtimeNotification`), never authoritative business state.
- **REST as Single Truth:** Upon receipt of invalidation events, views execute fresh typed queries against authoritative REST endpoints.
- **Strict Tenant Isolation:** Sockets authenticate via JWT in `handshake.auth.token`, verify active database organization membership, and join server-derived `org:<organizationId>` rooms.
- **Zero Client Mutations:** Inbound client mutation commands over WebSockets are systematically rejected.

### 7.2 Live Refetching Coordination
- `DashboardView`: Reacts to `dashboard.changed`, `recovery.*`, and `exception.*` with 300ms burst coalescing.
- `ExceptionsView`: Live refreshes on `exception.created` and `exception.updated`.
- `RecoveriesView` & `RecoveryDetailView`: Live updates on `recovery.updated` and `recovery.approval_decided`. Reduces polling to background safety net.
- `ApprovalPanel`: Concurrently synchronizes approval and rejection decisions across multiple operator tabs and windows, preventing double-decision attempts and stale modal states.
- `IntegrationsView` & `HealthView`: Instant status reflections upon provider connection, credential rotation, and disconnection.

### 7.3 Navigation & Production Polish
- **Header Live Status Indicator:** `AppShell` header features a real-time engine connectivity badge (`Live`, `Reconnecting`, `Offline`) with live socket lifecycle tracking.
- **Inactive Feature Cleanliness:** Unimplemented configuration routes (`Rules & Logic`, `Analytics`, `Settings`) render informational enterprise tags (`Enterprise`, `Coming Soon`, `Config`) and trigger modal explanations rather than navigating to broken dummy routes or displaying mock data.
