# FreshCart Backend

Multi-tenant grocery-delivery SaaS API. Node.js + Express + MongoDB (Mongoose).
Implements `BACKEND-DESIGN.txt` in full — read that document first; this
README is only how to run what it describes.

## Prerequisites

- Node.js 20+
- MongoDB 7, running as a **replica set** (transactions require it — see §2
  and §13 of the design doc). Standalone `mongod` will fail on every order
  placement, credit ledger write, and address primary swap.
- Redis (rate limiting, idempotency locks, BullMQ job queues)
- An S3-compatible bucket for file uploads (MinIO works for local dev)

### Local MongoDB replica set (Docker)

```bash
docker run -d --name freshcart-mongo -p 27017:27017 mongo:7 --replSet rs0
docker exec -it freshcart-mongo mongosh --eval "rs.initiate()"
```

### Local Redis

```bash
docker run -d --name freshcart-redis -p 6379:6379 redis:7
```

### Local MinIO (S3-compatible storage)

```bash
docker run -d --name freshcart-minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data --console-address ":9001"
```

Create a bucket named `freshcart` via the console at `localhost:9001`, and
set it to public-read for the image purposes (category tiles, product
photos, banners) — delivery proof photos stay private (§16).

## Setup

```bash
npm install
cp .env.example .env   # edit JWT_SECRET, S3_*, etc.
npm run seed            # creates the "freshcart-demo" tenant with a full fixture set
npm run dev              # starts the API + Socket.io + all BullMQ workers on :4000
```

The seed script (`src/seed/index.ts`) creates one tenant end-to-end,
including placing a real order through the actual pricing/order pipeline,
then runs every §21 assertion and fails loudly if any of them don't hold.
It's also the closest thing this project has to a smoke test — if `npm run
seed` passes, tenant isolation, pricing, the credit ledger, and order
placement all work together correctly.

Demo login after seeding:

```
POST /api/v1/auth/staff/login
{ "tenantSlug": "freshcart-demo", "email": "owner@freshcart-demo.test", "password": "ChangeMe123!" }
```

Every customer-facing and staff-facing request needs an `X-Tenant-Id`
header carrying the tenant's Mongo `_id` (find it via
`GET /api/v1/platform/tenants` as a super admin, or read it from the seed
script's log output) — see §1.2 of the design doc for the full resolution
order.

## Project layout

Mirrors §3 of the design doc:

```
src/
  config/       env, db, redis, logger
  context/      AsyncLocalStorage request context (§1.3)
  plugins/      tenantScope (isolation — §1.3) and toJSON
  models/       one file per collection (§4)
  modules/      routes + controller + service, one folder per domain
  middleware/   auth, validate, error, rateLimit, idempotency, tenantContext
  realtime/     Socket.io, namespaced per tenant (§14)
  jobs/         BullMQ queues + workers (import commit, rider timeout,
                nightly rollups, monthly invoices)
  lib/          money, phone, timezone, crypto, jwt, s3, otpProvider, ...
  seed/         the fixture + assertion script described above
  shared/       error-codes.json and icon-catalog.json — both are also the
                contract the client apps validate against; keep them in
                sync with the app source rather than editing by hand
```

## Testing

```bash
npm test
```

Uses `mongodb-memory-server` in **replica-set mode** (§23.3) — every
transaction test needs it; single-node mode will fail the same way a
standalone `mongod` does.

## What's here vs. what the design doc defers

Everything in `BACKEND-DESIGN.txt` §0–§25 is implemented, including
tenant isolation, the full route table, the pricing engine, the order state
machine with oversell/substitution handling, automatic rider assignment
with timeout/reassignment, the credit ledger, Excel import, file upload,
Socket.io, Expo push, analytics rollups, and the platform/billing layer.

Explicitly deferred, per §11/§12 of the design doc:

- **Payment gateway (Telr/PayTabs)** — D12/v2. Orders record a
  `paymentKind` and take no money; `tenant.gateway.credentialsEnc` exists
  as a field but nothing writes to it yet.
- **Real SMS/WhatsApp OTP delivery** — `lib/otpProvider.ts` ships a console
  provider for dev and throws clearly if `OTP_PROVIDER=sms|whatsapp` is set
  without credentials. Wiring a real aggregator is a few hours once an
  account exists (§5.3).
- **Delivery staff PWA / super admin portal** — their *backend* routes are
  fully implemented (`/delivery/*`, `/platform/*`); the frontends
  themselves don't exist yet, same as the CMS admin was before this round.
