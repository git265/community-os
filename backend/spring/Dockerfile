# Build:  docker build -t communityos-backend -f spring/Dockerfile .      (run from the backend/ folder: the schema in db/ is shared)
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY spring/pom.xml spring/pom.xml
COPY db db
COPY spring/src spring/src
RUN mvn -q -f spring/pom.xml -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /build/spring/target/communityos-backend-1.0.0.jar app.jar
ENV JAVA_OPTS="-XX:MaxRAMPercentage=75"
EXPOSE 8080
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar app.jar"]
