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
