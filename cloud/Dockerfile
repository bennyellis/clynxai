# Build context is the REPOSITORY ROOT (docker build -f cloud/Dockerfile .): the image contains the API, the worker and the built website. See DEPLOYMENT.md.
FROM node:20-alpine AS website
WORKDIR /website
COPY website/package*.json ./
RUN npm ci
COPY website/ ./
RUN npm run build

FROM node:20-alpine AS build
WORKDIR /app
COPY cloud/package*.json ./
RUN npm ci
COPY cloud/ ./
RUN npm run build
# tsc only emits compiled .js — the migration runner reads its .sql files
# from a directory next to itself at runtime, so they have to be copied in.
RUN cp -r src/db/migrations dist/db/migrations

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV WEBSITE_DIR=/app/website
ENV RELEASES_DIR=/data/releases
COPY cloud/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=website /website/dist ./website
# uploaded installers live on a volume mounted at /data (back it up with the database)
RUN mkdir -p /data/releases && chown -R node:node /data
VOLUME ["/data"]
# run as the unprivileged "node" user that ships in the image
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3   CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
