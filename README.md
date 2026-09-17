# Reloop

Reloop is an e-commerce reliability and recovery platform that detects inconsistent order states across connected systems, coordinates safe recovery, and verifies that the systems agree before marking an incident resolved.

Core Operating Rule:
CHECK → EXECUTE → VERIFY → RESOLVED

Current status: technical foundation (Day 2)

## Local Development Quickstart

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Configuration
```bash
cp .env.example .env
```

### 3. Start Infrastructure Services
```bash
docker compose up -d
```
Starts PostgreSQL on host port `5433` and Redis on host port `6380`.

### 4. Database Setup
```bash
npm run db:validate
npm run db:generate
```

### 5. Run Applications & Services
- **Core API (NestJS, port 3101):**
  ```bash
  npm run dev --workspace=@reloop/api
  ```
- **Web App (Next.js, port 3100):**
  ```bash
  npm run dev --workspace=@reloop/web
  ```
- **Scheduler (Skeleton):**
  ```bash
  npm run dev --workspace=@reloop/scheduler
  ```
- **Worker (Skeleton):**
  ```bash
  npm run dev --workspace=@reloop/worker
  ```
