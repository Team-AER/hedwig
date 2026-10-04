# Running Hedwig

Use the Hedwig compose file from this repository. It builds the web client and API locally, starts a separate intelligence worker, and includes PostgreSQL 16 with pgvector and Redis 7. Models, embeddings, and Apache Tika are external services; none is bundled by this compose file.

## Container setup

Prerequisites: Git, Docker, and Docker Compose; IMAP/SMTP access to the accounts you want to connect; and a domain/TLS arrangement for a public deployment.

```bash
git clone https://github.com/Team-AER/hedwig.git
cd hedwig
cp .env.hedwig.example .env
```

Edit `.env` before starting:

| Setting | What to configure |
| --- | --- |
| `APP_URL` | Application origin, for example `https://hedwig.example.com` |
| `SESSION_SECRET` | Independent random session secret: `openssl rand -hex 32` |
| `DB_PASSWORD` | Independent strong database password |
| `ENCRYPTION_KEY` | Independent 32-byte hex encryption key: `openssl rand -hex 32`; retain it for decrypting stored account credentials |
| `APP_PORT`, `APP_HTTP_PORT` | HTTPS and HTTP host ports; defaults 443 and 80 |
| `HEDWIG_LLM_BASE_URL` | Your reachable OpenAI-compatible model gateway |
| `HEDWIG_LLM_CATALOG_URL` | Your optional gateway model catalog |
| `HEDWIG_LLM_MODELS_FAST`, `HEDWIG_LLM_MODELS_LONG`, `HEDWIG_LLM_MODELS_AGENT` | Models actually available at your gateway |
| `HEDWIG_EMBEDDINGS_PROVIDER` | `openai` for an embeddings API, `hash` for lexical vectors, or `off` |
| `HEDWIG_EMBEDDINGS_BASE_URL`, `HEDWIG_EMBEDDINGS_MODEL`, `HEDWIG_EMBEDDINGS_DIMS` | Embedding endpoint, model, and compatible dimensions |
| `HEDWIG_INDEX_TIKA_ENABLED`, `HEDWIG_INDEX_TIKA_URL` | Set extraction to `false`, or configure your own Tika service |
| `TZ`, `HEDWIG_INSIGHTS_TIMEZONE` | Desired installation timezone; users can override briefing preferences |

**The example and compose file contain installation-specific endpoint/model defaults. Replace them with your own services.** Empty environment values in the compose file can fall back to its defaults (`${VAR:-default}`); in particular, leaving the model base URL empty in `.env` does not disable models in this stack. To run without models, start the stack and set the base URL to empty in the administrator’s Hedwig settings. For embeddings without a server, set `HEDWIG_EMBEDDINGS_PROVIDER=hash` or `off`; to avoid attachment extraction, explicitly set `HEDWIG_INDEX_TIKA_ENABLED=false`.

Optional API keys are configured through administrator model settings. Consult [the configuration schema](../../backend/src/hedwig/config.js) for available settings and environment/admin/user precedence. Keep `.env` outside version control.

```bash
docker compose -f docker-compose.hedwig.yml config --quiet
docker compose -f docker-compose.hedwig.yml up -d --build
docker compose -f docker-compose.hedwig.yml ps
```

Open `APP_URL`. The first registered user becomes administrator. Set registration/invitation policy, configure models and pipeline settings, and connect accounts in Settings → Accounts. [Microsoft accounts](ACCOUNTS-MICROSOFT.md) require an application registration and the documented OAuth settings.

## HTTPS and reverse proxies

The frontend nginx container serves ports 80 and 443 and mounts `./certs` at `/etc/nginx/ssl`. Its startup script generates a self-signed certificate when none exists. For trusted HTTPS, provide certificates matching the paths in [nginx.conf](../../frontend/nginx.conf), or put your TLS-terminating reverse proxy in front of the HTTP port.

Forward `X-Forwarded-Proto: https` when terminating TLS upstream, and support the WebSocket upgrade used for mail notifications. Choose host ports in `.env` that do not conflict with your reverse proxy. The inherited HTTPS overlay targets the upstream stack; it is not required by the Hedwig setup documented here.

## Data and updates

Named volumes store PostgreSQL, Redis, and external plugins. Back up the database, plugin files, encryption key, configuration, and any custom certificates before an upgrade. Database migrations run when the API starts; the worker waits for the Hedwig schema.

```bash
git pull --ff-only
docker compose -f docker-compose.hedwig.yml up -d --build
```

A source build updates this fork’s application; `docker compose pull` alone does not rebuild it. Avoid `down -v` unless you intend to remove stored data. See worker logs and administrator pipeline health when investigating model/indexing failures.

## Local development

Use Node.js **22** (the backend engine range is `>=22 <23`), npm, Docker/Compose, and the database services from `docker-compose.devdb.yml`. That file publishes PostgreSQL on loopback port 55432 and Redis on loopback port 56379.

```bash
docker compose -f docker-compose.devdb.yml up -d
cd backend
npm ci
```

Create an untracked `backend/.env` containing:

```dotenv
NODE_ENV=development
APP_URL=http://localhost:5173
FRONTEND_URL=http://localhost:5173
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=55432
DB_NAME=mailflow
DB_USER=mailflow
DB_PASSWORD=hedwig-dev
REDIS_URL=redis://127.0.0.1:56379
SESSION_SECRET=replace-with-an-independent-generated-secret
ENCRYPTION_KEY=replace-with-64-hex-characters
HEDWIG_LLM_BASE_URL=
HEDWIG_EMBEDDINGS_PROVIDER=hash
HEDWIG_INDEX_TIKA_ENABLED=false
```

The database credentials above are for the loopback-only development compose file. Retained `mailflow` database identifiers are compatibility defaults, not a separate upstream installation. Backend scripts load `.env` from their current working directory.

In separate terminals:

```bash
# backend/: runs API and migrations
npm run dev

# backend/: runs pipeline and schedules after the API has initialized the schema
node src/hedwig/worker.js

# frontend/
npm ci
npm run dev -- --config vite.local.config.js
```

The checked-in `vite.config.js` targets the container hostname `backend` and proxies only `/api` and `/ws`. For the host-based development setup above, create an untracked `frontend/vite.local.config.js` before starting Vite:

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/oauth': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
```

Open `http://localhost:5173`. Do not use production mailbox credentials or data for test fixtures.

## Checks

From `backend/`, run `npm test`, `npm run lint`, and `npm run lint:plugins`. From `frontend/`, run `npm test`, `npm run lint`, and `npm run build`.

For database integration tests, first start the development database, configure `backend/.env`, and apply migrations:

```bash
# backend/
node scripts/hedwig-migrate.mjs
npm run test:hedwig-it
```

Integration tests share database state and run sequentially. Use a disposable development database. They must not depend on live gateways; model quality evaluation and actual provider connectivity are separate checks.
