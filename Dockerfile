# Dockerfile
FROM node:22-alpine

WORKDIR /usr/src/app

RUN apk add --no-cache ca-certificates && update-ca-certificates

# Install all deps (including esbuild) so the map client can be built in-image.
COPY package*.json ./
RUN npm install

# Copy app sources, build map bundle + vendor MapLibre, then drop devDependencies.
COPY . .
RUN npm run build:map && npm prune --omit=dev

ENV NODE_ENV=production

# The app uses WEB_UI_PORT from env, default to 3000
EXPOSE 3000

# exec so SIGTERM reaches Node (npm start prints a fake "command failed" on recreate).
CMD ["sh", "-c", "node scripts/ensure-map-built.mjs && exec node --use-system-ca server.js"]
