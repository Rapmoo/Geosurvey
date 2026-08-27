# ===================================================================
# Dockerfile — geosurvey-file-storage-api (root package.json)
# -------------------------------------------------------------------
# Builds the Express backend only. The PWA is a separate static app
# with its own Dockerfile at PWA/Dockerfile — see docker-compose.yml,
# which builds and runs both together.
#
# Installs from the ROOT package.json (geosurvey-file-storage-api),
# not Backend/package.json (that one's a dependency-light manifest
# only used by `firebase deploy --only functions` — see README's
# "Two package.json files" section). Don't `cd Backend && npm ci`
# here; the Express app's deps aren't in that manifest.
# ===================================================================
FROM node:20-alpine

WORKDIR /app

# Install deps first so this layer stays cached across source-only edits.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Backend source only — PWA/, Backup System/, docs, etc. aren't needed
# to run the API and are excluded via .dockerignore anyway.
COPY Backend ./Backend

# STORAGE_ROOT defaults to "./storage" (see Backend/services/
# fileStorageService.js), resolved against process.cwd() — which is
# /app here, same as when `npm start` is run from the repo root
# locally. That's why this is /app/storage and NOT /app/Backend/storage.
# Real uploaded files must live on a persistent volume mounted here
# (see docker-compose.yml) — this mkdir just gives the app somewhere
# to write if the container is ever run without one attached.
RUN mkdir -p storage

# Run as a non-root user rather than the image's default root.
RUN addgroup -S geosurvey && adduser -S geosurvey -G geosurvey \
    && chown -R geosurvey:geosurvey /app
USER geosurvey

ENV NODE_ENV=production
EXPOSE 8080

# app.js already exposes GET /healthz for exactly this purpose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "Backend/server.js"]
