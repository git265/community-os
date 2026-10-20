# CommunityOS back end

Start here: **docs/BACKEND.md** (design, REST contract, how to run), **docs/INTEGRATIONS.md** (every outside system and how to switch vendor),
**docs/MYGATE_MIGRATION.md** (moving from MyGate).

```
db/                 V1__documents.sql  (the one schema)
spring/             the Spring Boot service (Java 21, Maven)   mvn spring-boot:run -Dspring-boot.run.profiles=memory
contract-server/    Node stand-in on the same schema/contract  node server.mjs   (development only)
docker-compose.yml  postgres + service (+ MinIO, Mailpit)      docker compose up -d --build
.env.example        every setting
```
The Spring project has not been compiled in the environment that wrote it (no Maven Central access); see docs/BACKEND.md §7.
