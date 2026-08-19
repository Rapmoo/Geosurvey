# ===================================================================
# Dockerfile — GeoSurvey PWA (static frontend)
# -------------------------------------------------------------------
# No build step: PWA/js/app.js is loaded straight from the browser as
# plain ES modules (see scripts/build.js's own comment on this), so
# this image just ships the static files behind nginx.
#
# Listens on 80 inside the container; docker-compose.yml maps host
# port 8000 -> 80, matching the backend's ALLOWED_ORIGINS=
# http://localhost:8000 in Backend/.env and the hardcoded
# KOBO_API_BASE = 'http://localhost:8080' in app.js (the browser talks
# to the backend directly on the host, not through this container).
# ===================================================================
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null || exit 1
