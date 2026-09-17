# Reloop Design System & UI Architecture

## 1. Design Philosophy: The Operational Console

Reloop is built for fulfillment and operations managers responsible for tens of thousands of dollars in daily physical inventory. When an operator opens Reloop, they need high clarity, dense and legible information, and trustworthy operational status—not decorative entertainment or consumer-app gimmicks.

### Aesthetic Principles
- **Calm & Predictable**: Low visual noise. High contrast where attention is needed, neutral calm everywhere else.
- **Operational Density**: Tables and lists prioritize scannability, displaying critical identifiers, timestamps, and statuses without unnecessary whitespace inflation.
- **Functional Semantics**: Every color, badge, and border serves an explicit operational purpose. Color is never used purely for decoration.
- **Zero AI Clutter**: No shimmering purple gradients, pulsating stars, or floating chat bubbles.
- **Restrained Physicality**: Crisp 1px borders, subtle surface elevations, no gratuitous glassmorphism or oversized rounded corners.

---

## 2. Color System & Functional Roles

Color in Reloop communicates system state, operational urgency, and convergence status.

```
Neutral Base (Slate/Zinc) ────── Foundation, layout surfaces, typography, structural borders
Deep Navy/Cobalt ────────────── Primary action color, stable identity, focused interactions
Amber / Ochre ────────────────── Attention required, waiting for approval, degraded state
Crimson / Rose ───────────────── Dangerous condition, blocked operation, integration failure
Emerald / Forest ─────────────── Verified converged, healthy integration, resolved
Cyan / Slate Blue ────────────── In-flight recovery, active investigation
```

### Color Palette Specification

#### 1. Neutrals (Foundational Canvas)
- `neutral-950` (`#090D14`): Primary high-contrast text, dark mode canvas base.
- `neutral-900` (`#0F172A`): Deep headers, dark mode surface layer 1.
- `neutral-700` (`#334155`): Secondary body text, icons, table headers.
- `neutral-500` (`#64748B`): Muted helper text, disabled states, timestamps.
- `neutral-300` (`#CBD5E1`): Active input borders, divider lines.
- `neutral-200` (`#E2E8F0`): Subtle table borders, container outlines.
- `neutral-100` (`#F1F5F9`): Table header backgrounds, zebra rows, badge backdrops.
- `neutral-50` (`#F8FAFC`): Main app canvas background, inset panels.
- `white` (`#FFFFFF`): Card surfaces, modal surfaces, table cell backgrounds.

#### 2. Functional Accent: Focused Operational Blue (`#0F52BA` / `slate-blue-600` `#2563EB`)
- **Functional Role**: Represents human focus and deliberate action. Used for primary buttons (`Approve Recovery`), active navigation indicators, and primary links. Does not flash or gradient.

#### 3. Semantic Status Roles

| Semantic Role | Background | Border | Text | Operational Meaning |
| :--- | :--- | :--- | :--- | :--- |
| **Resolved / Healthy** | `#ECFDF5` (Emerald-50) | `#A7F3D0` (Emerald-200) | `#065F46` (Emerald-800) | State verified converged, system healthy. |
| **Investigating / In-Flight**| `#EFF6FF` (Blue-50) | `#BFDBFE` (Blue-200) | `#1E40AF` (Blue-800) | Reloop is actively reading systems or retrying. |
| **Needs Approval / Caution** | `#FFFBEB` (Amber-50) | `#FDE68A` (Amber-200) | `#92400E` (Amber-800) | Action queued; waiting for human review. |
| **Blocked / Critical Error** | `#FEF2F2` (Rose-50) | `#FECACA` (Rose-200) | `#991B1B` (Rose-800) | Dangerous condition (duplicate risk, invalid data). |
| **Neutral / Open** | `#F8FAFC` (Slate-50) | `#E2E8F0` (Slate-200) | `#334155` (Slate-700) | Idle, draft, or unassigned state. |

---

## 3. Typography Hierarchy

Reloop uses a modern, highly legible system font stack prioritizing clarity at small font sizes and tabular alignment.

- **Primary Font Family**: `Inter`, `-apple-system`, `BlinkMacSystemFont`, `"Segoe UI"`, `Roboto`, `sans-serif`.
- **Monospace Family (for Order #, Tracking #, SKU, Timestamps)**: `"JetBrains Mono"`, `"SFMono-Regular"`, `Menlo`, `Consolas`, `monospace`.

### Type Scale

| Level | Size | Weight | Line Height | Usage |
| :--- | :--- | :--- | :--- | :--- |
| **Display / Page Title** | 20px (`1.25rem`) | 600 (Semibold) | 28px (`1.75rem`) | Page header (e.g., "Exceptions", "Recovery Detail") |
| **Section Header** | 16px (`1.0rem`) | 600 (Semibold) | 24px (`1.5rem`) | Card titles, panel headers, section dividers |
| **Subheading** | 14px (`0.875rem`) | 600 (Semibold) | 20px (`1.25rem`) | Modal headings, preview section labels |
| **Body (Default)** | 14px (`0.875rem`) | 400 (Regular) | 20px (`1.25rem`) | Standard table text, descriptions, details |
| **Body Small / Secondary**| 12px (`0.75rem`) | 400 / 500 | 16px (`1.0rem`) | Helper labels, timestamps, metadata |
| **Status Badge** | 11px (`0.6875rem`) | 600 (Semibold) | 14px | All operational status indicators (uppercase tracking) |
| **Monospace Data** | 13px (`0.8125rem`) | 500 (Medium) | 18px | Order numbers, SKU tags, tracking IDs, postal codes |

---

## 4. Spacing Scale & Layout Grid

Strict 4px geometric progression:
- `space-1`: 4px — tight badge padding, inline icon gaps
- `space-2`: 8px — button horizontal padding, field gaps
- `space-3`: 12px — form field vertical padding, card inner gaps
- `space-4`: 16px — standard padding for table cells, card body
- `space-5`: 20px — modal interior spacing
- `space-6`: 24px — page gutter, section padding
- `space-8`: 32px — large container margins
- `space-12`: 48px — empty state vertical rhythm

### Container Max-Width
- Global Content Container: `max-w-7xl` (1280px) to `max-w-screen-2xl` (1536px) for widescreen multi-column tables.
- Drawer / Recovery Preview: `w-full max-w-xl` (576px) or side-by-side split screen.

---

## 5. Surface Hierarchy & Border Philosophy

- **No Over-Rounded Shapes**: Reloop avoids oversized bubble geometry. Standard corner radius is crisp and functional:
  - Buttons, Inputs, Badges: `rounded-md` (6px)
  - Cards, Containers, Modals: `rounded-lg` (8px)
  - Interactive Pills: `rounded-full` (only for small status badges)
- **Border Treatment**:
  - Crisp, structural 1px borders (`border border-neutral-200`).
  - Subtle drop shadows are reserved strictly for floating overlays (menus, popovers, modals: `shadow-sm` to `shadow-md`). Cards sitting in the grid use flat 1px borders with zero ambient blur.
- **Surface Elevation**:
  - Base: Canvas `#F8FAFC`
  - Layer 1: Content card / Table container `#FFFFFF`
  - Layer 2: Inset panels / Table headers `#F1F5F9`
  - Layer 3: Modals / Flyout Drawers `#FFFFFF` with semi-transparent scrim (`rgba(15, 23, 42, 0.4)`)

---

## 6. Core Component Guidelines

### 1. Data Tables
- **Header**: Height 36px, uppercase 11px semi-bold with muted color (`neutral-500`), subtle bottom border.
- **Rows**: Fixed height (48px for compact density, 56px for standard).
- **Zebra Striping**: Clean alternating rows or subtle hover effect (`bg-neutral-50/70`).
- **Alignment**: Text left-aligned; numerical values, timestamps, and currency right-aligned; badges center-aligned.
- **Monospace Identifiers**: Order `#` and tracking codes rendered in monospace font for rapid character comparison.

### 2. Status Badges
- Compact pill height: 22px.
- Subtle background tint (50-level) with solid 1px border (200-level) and high-contrast text (800-level).
- Semantic dot indicator (6px circle) preceding label to assist accessibility and quick visual identification.
- Exact Status Set:
  - `OPEN` (Slate)
  - `INVESTIGATING` (Blue)
  - `READY_FOR_RECOVERY` (Blue)
  - `WAITING_APPROVAL` (Amber)
  - `RECOVERING` (Indigo)
  - `VERIFYING` (Cyan)
  - `RESOLVED` (Emerald)
  - `BLOCKED` (Rose)
  - `FAILED` (Red)

### 3. Recovery Level Badges
Displayed alongside exception statuses to identify execution policy:
- `AUTO_RECOVER`: Teal border, subtle gear icon.
- `AUTO_INVESTIGATE`: Blue border, subtle magnifying icon.
- `REQUIRE_APPROVAL`: Amber border, human-user icon.
- `BLOCK`: Rose border, shield-lock icon.

### 4. Buttons
- **Primary Action** (`Approve Recovery`, `Connect Store`): Solid `#0F52BA`, white text, 6px radius, hover brightness-105.
- **Destructive / Danger** (`Reject`, `Halt Sync`): Ghost or outline with `#991B1B` border and text.
- **Secondary / Outline** (`Filter`, `Export`, `Cancel`): White surface, 1px `#CBD5E1` border, dark text.
- **Icon Button**: 32x32px square with centered 16px icon for table row actions.

### 5. Form Fields
- Height: 36px (compact operational height).
- 1px neutral border (`#CBD5E1`), 6px radius. Focus ring is a clean 2px navy outline with 0px offset.
- Explicit label placed above input (never floating placeholder-only labels that disappear when typed).

### 6. Side Navigation & Top Bar
- Side navigation items include 18px stroke icons with clear 14px labels. Active item marked with solid left border accent and high-contrast text.
- Top bar displays the global **Operational Mode Pill**:
  - `SHADOW: OBSERVE` (Grey/Blue)
  - `RECOMMEND` (Blue)
  - `APPROVAL` (Amber)
  - `SAFE AUTO-RECOVERY` (Green)

### 7. Empty States
- No cartoonish or humorous illustrations.
- Clean technical icon, clear 14px heading, single-sentence explanation of why the view is empty, and a direct primary action button.

### 8. Loading States
- Content skeletons matching the exact structural layout of tables and KPI cards (no generic spinning wheels in empty space).
- Background pulse animation is slow and subtle (1.5s duration).

### 9. Error States
- Explicit, unambiguous error banners explaining *what failed*, *the upstream service involved*, and *how to remediate*.
- Manual retry action always visible.

---

## 7. Responsive & Mobile Behavior

While fulfillment operations managers primarily work on desktop displays with multi-column views, Reloop provides complete responsive degradation:
- **Tablet (768px - 1024px)**:
  - Sidebar collapses to compact icon-only mode.
  - Tables enable horizontal scrolling with pinned order number and status columns.
- **Mobile (< 768px)**:
  - Sidebar converts to bottom drawer menu.
  - Tables convert into stacked cards displaying Order #, Status Badge, Problem Type, and tap-to-expand details.
  - Recovery Preview switches from side drawer to full-screen modal with fixed bottom approval button.
