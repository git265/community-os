# CommunityOS back end

One service: **`api/`** — Spring Boot 3.5 on Java 25, PostgreSQL 18, typed `/api/v1` endpoints, one table per object. The web app's
"Back end" data source talks only to it. Design, API and how to run: **docs/REDESIGN.md**.

```
api/                the service (Maven)                       cd api && mvn verify
api/src/main/resources/db/migration   the schema (Flyway)     api/tools/migrate-local.sh <db>, api/tools/test-schema.sh
docker-compose.yml  postgres + api + seed + demo + web        docker compose up -d --build     (http://localhost:8081)
docker-compose.prod.yml  + HTTPS (Caddy), closed ports, restarts   on a server: docs/DEPLOY-LIGHTSAIL.md, docs/DEPLOY-DIGITALOCEAN.md
.env.example        the settings docker compose passes
```

The earlier servers (`contract-server/`, the Node reference; `spring/`, its Spring port; `platform/` and `db/`, their schemas) were retired
after r76: everything they did is in `api/`. They are in git history (tag `baseline-r76`, commit 9ef79c0) if anything needs looking up.
