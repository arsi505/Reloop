# Reloop External E-Commerce System Simulator

The **Reloop Simulator** (`@reloop/simulator`) is a realistic, development-only external system emulator designed to mimic the core operational behaviors, state representations, and failure modes of e-commerce platforms and fulfillment providers:

1. **Shopify** (E-commerce Order Management & Inventory)
2. **ShipStation** (Shipping & Fulfillment Carrier Platform)
3. **Generic Warehouse / 3PL** (Third-Party Logistics Fulfillment Engine)

---

## 1. Architectural Purpose & Isolation Guarantee

Real-world e-commerce recovery systems fail when external APIs behave unpredictably, rate-limit callers, delay responses, or silently commit state before timing out. The simulator allows developers and integration tests to verify Reloop's state-sync and reconciliation engines deterministically—without incurring third-party API costs or relying on external sandbox availability.

### Port & Networking
- **Dedicated Port**: `3102` (`http://localhost:3102`)
- **Environment Variable**: `SIMULATOR_PORT=3102`

### Strict In-Memory Limitation & Database Safety
- **100% In-Memory State**: All simulated orders, shipments, inventory counts, and fault injection rules reside in volatile process memory (`SimulatorStateService`).
- **Zero Database Interactions**: The simulator has **no connection** to PostgreSQL or Prisma.
- **Isolated Reset**: Executing `POST /_simulator/reset` purges **only** the simulator's volatile memory. It **never** drops tables, clears PostgreSQL, alters Redis coordination data, resets Reloop users or organizations, or touches Docker volumes.

---

## 2. Provider API Routes

The simulator exposes endpoints mirroring standard REST patterns of each simulated provider.

### Shopify (`/shopify/*`)
- `GET /shopify/orders` — List simulated Shopify orders
- `GET /shopify/orders/:id` — Retrieve Shopify order by ID or order number
- `POST /shopify/orders` — Create an order
- `POST /shopify/orders/:id/fulfill` — Mark order as fulfilled with tracking details
- `GET /shopify/inventory/:sku` — Query Shopify stock level for a SKU
- `PUT /shopify/inventory/:sku` — Update Shopify stock level for a SKU

### ShipStation (`/shipstation/*`)
- `GET /shipstation/shipments` — List simulated shipments
- `GET /shipstation/shipments/:id` — Retrieve shipment by ID
- `GET /shipstation/shipments/order/:orderNumber` — Retrieve shipments for an order
- `POST /shipstation/shipments` — Create shipment / generate label
- `POST /shipstation/shipments/:id/tracking` — Assign or update tracking number and carrier

### Generic 3PL / Warehouse (`/3pl/*`)
- `GET /3pl/orders` — List warehouse fulfillment orders
- `GET /3pl/orders/search?reference=...&orderNumber=...` — Search warehouse orders
- `GET /3pl/orders/:id` — Retrieve warehouse order by ID or order number
- `POST /3pl/orders` — Submit an order to the warehouse for fulfillment
  - Enforces validations: duplicate check (`DUPLICATE_ORDER`), SKU validation (`INVALID_SKU`), postal code validation (`INVALID_ADDRESS`).
- `PATCH /3pl/orders/:id/status` — Advance status (`RECEIVED` → `PENDING_FULFILLMENT` → `PICKING` → `PACKED` → `SHIPPED` → `DELIVERED`; observable: `REJECTED`, `CANCELLED`)
- `GET /3pl/inventory/:sku` — Query 3PL warehouse stock level for a SKU
- `PUT /3pl/inventory/:sku` — Update 3PL warehouse stock level for a SKU

---

## 3. Simulator Control API

The simulator provides administrative control endpoints prefixed with `/_simulator/`:

| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Service health check & simulated provider statuses |
| `POST` | `/_simulator/reset` | Clears all in-memory orders, inventory, and fault rules safely |
| `POST` | `/_simulator/seed/:scenario` | Pre-seeds a named discrepancy or test scenario |
| `GET` | `/_simulator/faults` | Lists active fault injection rules |
| `POST` | `/_simulator/faults` | Registers a deterministic fault rule |
| `DELETE` | `/_simulator/faults` | Clears all registered fault rules |
| `GET` | `/_simulator/state` | Returns complete current state across all 3 providers and fault rules |

---

## 4. Deterministic Failure Injection

Faults can be injected globally or targeted by provider (`shopify`, `shipstation`, `3pl`), endpoint path pattern, or HTTP method. Active faults match incoming requests, execute the behavior, and decrement their `remainingCalls` count until automatically consumed.

### Supported Fault Types

1. **`RETURN_429`**: Simulates provider rate limits.
   - Status: `HTTP 429 Too Many Requests`
   - Headers: `Retry-After: <seconds>` (default: `5`)
   - Error code: `RATE_LIMIT_EXCEEDED` (`retryable: true`)

2. **`RETURN_503`**: Simulates provider outages or temporary downtime.
   - Status: `HTTP 503 Service Unavailable`
   - Error code: `SIMULATED_SERVICE_UNAVAILABLE` (`retryable: true`)

3. **`TIMEOUT`**: Simulates dropped connections or gateway timeouts.
   - Status: `HTTP 504 Gateway Timeout` after configurable delay (default: `5000ms`)
   - Error code: `GATEWAY_TIMEOUT` (`retryable: true`)

4. **`SLOW_RESPONSE`**: Simulates severe network latency before successful response.
   - Injects a delay before yielding normal response.

5. **`INVALID_SKU`**: Rejects order submission due to invalid or unmapped catalog item.
   - Status: `HTTP 422 Unprocessable Entity`
   - Error code: `INVALID_SKU` (`retryable: false`)

6. **`INVALID_ADDRESS`**: Rejects order submission due to undeliverable shipping destination.
   - Status: `HTTP 422 Unprocessable Entity`
   - Error code: `INVALID_ADDRESS` (`retryable: false`)

7. **`ORDER_NOT_FOUND`**: Simulates missing record.
   - Status: `HTTP 404 Not Found`
   - Error code: `ORDER_NOT_FOUND` (`retryable: false`)

8. **`DUPLICATE_ORDER`**: Simulates warehouse rejection when an order reference was already submitted.
   - Status: `HTTP 409 Conflict`
   - Error code: `DUPLICATE_ORDER` (`retryable: false`)

9. **`COMMIT_THEN_TIMEOUT`**: Simulates ambiguous downstream network failure during mutation.
   - **Behavior**: The simulator **commits** the mutation to state memory first, then delays and returns `HTTP 504 Gateway Timeout`.
   - **Relevance to Reloop**: Tests the core rule **"CHECK → EXECUTE → VERIFY → RESOLVED"**. An HTTP 504 error during order creation must NOT cause Reloop to blindly retry and create duplicates; Reloop must first query (`CHECK`/`VERIFY`) whether the order already exists at the provider.

---

## 5. Named Discrepancy & Test Scenarios

The simulator includes 10 pre-configured scenarios executable via `POST /_simulator/seed/:scenario`:

| Scenario Name | Description | Seeded State |
| :--- | :--- | :--- |
| `HEALTHY_ORDER` | Baseline scenario where all systems agree. | Order `ORD-9001` exists in Shopify (`PAID`), ShipStation (`PENDING`), and 3PL (`RECEIVED`). |
| `TEMPORARY_3PL_FAILURE` | Transient failure on warehouse submission. | Seeds order in Shopify, registers a 1-call `RETURN_503` rule on `/3pl/*`. |
| `TRACKING_MISSING_IN_SHOPIFY` | Shipping generated tracking, but Shopify not updated. | ShipStation has tracking `TRK-UPS-9002` (`SHIPPED`); Shopify is still `UNFULFILLED` with no tracking. |
| `STUCK_ORDER` | Order received at 3PL but never processed or shipped. | Shopify is `UNFULFILLED`; 3PL order `ORD-9003` stuck in `RECEIVED` state. |
| `MISSING_AT_3PL` | Order paid in Shopify but never reached the warehouse. | Shopify order `ORD-9004` is `PAID`/`UNFULFILLED`; 3PL order is completely absent. |
| `SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY` | 3PL shipped the goods, but Shopify order remains unfulfilled. | 3PL order `ORD-9005` is `SHIPPED` with tracking `TRK-FDX-9005`; Shopify is `UNFULFILLED`. |
| `INVENTORY_MISMATCH` | Stock levels diverge between systems. | SKU `SKU-MISMATCH-01`: Shopify inventory = `100`, 3PL inventory = `82`. |
| `DUPLICATE_RISK` | Order already submitted to 3PL. | Order `ORD-9006` exists in 3PL (`PICKING`). Re-submitting the same order returns `409 DUPLICATE_ORDER`. |
| `INVALID_ORDER_DATA` | Order contains corrupted postal code. | Shopify order `ORD-9007` has address `BAD-POSTAL-99999`. 3PL rejects submission with `422 INVALID_ADDRESS`. |
| `AMBIGUOUS_TIMEOUT` | Mutation succeeds at 3PL, but client receives a timeout. | Registers a `COMMIT_THEN_TIMEOUT` fault rule on `POST /3pl/orders` with order `ORD-9008`. |

---

## 6. Example Usage & cURL Commands

### 6.1 Inspect Health
```bash
curl -s http://localhost:3102/health
```

### 6.2 Seed Scenarios
```bash
# 1. Healthy Order
curl -s -X POST http://localhost:3102/_simulator/seed/HEALTHY_ORDER

# 2. Tracking Missing in Shopify
curl -s -X POST http://localhost:3102/_simulator/seed/TRACKING_MISSING_IN_SHOPIFY

# 3. Missing at 3PL
curl -s -X POST http://localhost:3102/_simulator/seed/MISSING_AT_3PL

# 4. Shipped at 3PL but Unfulfilled at Shopify
curl -s -X POST http://localhost:3102/_simulator/seed/SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY

# 5. Inventory Mismatch
curl -s -X POST http://localhost:3102/_simulator/seed/INVENTORY_MISMATCH

# 6. Duplicate Risk
curl -s -X POST http://localhost:3102/_simulator/seed/DUPLICATE_RISK

# 7. Invalid Order Data
curl -s -X POST http://localhost:3102/_simulator/seed/INVALID_ORDER_DATA

# 8. Temporary 3PL Failure
curl -s -X POST http://localhost:3102/_simulator/seed/TEMPORARY_3PL_FAILURE

# 9. Stuck Order
curl -s -X POST http://localhost:3102/_simulator/seed/STUCK_ORDER

# 10. Ambiguous Timeout
curl -s -X POST http://localhost:3102/_simulator/seed/AMBIGUOUS_TIMEOUT
```

### 6.3 Inspect Provider State
```bash
# View all simulator state (Shopify, ShipStation, 3PL, Faults)
curl -s http://localhost:3102/_simulator/state

# Inspect a specific Shopify order
curl -s http://localhost:3102/shopify/orders/ORD-9001

# Inspect ShipStation shipments for an order
curl -s http://localhost:3102/shipstation/shipments/order/ORD-9001

# Search 3PL orders by order number or external reference
curl -s "http://localhost:3102/3pl/orders/search?orderNumber=ORD-9001"

# Compare inventory levels between Shopify and 3PL
curl -s http://localhost:3102/shopify/inventory/SKU-MISMATCH-01
curl -s http://localhost:3102/3pl/inventory/SKU-MISMATCH-01
```

### 6.4 Inject Custom Fault Rules
```bash
# Inject a 429 Rate Limit on Shopify order lookups for 2 calls with 10s Retry-After
curl -s -X POST http://localhost:3102/_simulator/faults \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "shopify",
    "pathPattern": "/orders",
    "faultType": "RETURN_429",
    "remainingCalls": 2,
    "retryAfterSeconds": 10
  }'

# Inject a COMMIT_THEN_TIMEOUT on 3PL order creation
curl -s -X POST http://localhost:3102/_simulator/faults \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "3pl",
    "pathPattern": "/orders",
    "httpMethod": "POST",
    "faultType": "COMMIT_THEN_TIMEOUT",
    "remainingCalls": 1,
    "delayMs": 100
  }'

# List active fault rules
curl -s http://localhost:3102/_simulator/faults

# Delete all fault rules
curl -s -X DELETE http://localhost:3102/_simulator/faults
```

### 6.5 Reset Simulator State
```bash
# Resets in-memory state cleanly; never affects PostgreSQL or Redis
curl -s -X POST http://localhost:3102/_simulator/reset
```