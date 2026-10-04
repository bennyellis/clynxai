FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# tsc only emits compiled .js — the migration runner reads its .sql files
# from a directory next to itself at runtime, so they have to be copied in.
RUN cp -r src/db/migrations dist/db/migrations

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
