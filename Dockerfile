FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY scripts/ ./scripts/

# Commit desplegado, para GET /api/v1/internal/version.
#
# Va como build arg y no se resuelve en ejecución a propósito: la imagen no copia
# `.git`, así que dentro del contenedor no hay repo que consultar. Lo pasa
# `deploy-vps.sh` con `--build-arg GIT_COMMIT=$(git rev-parse HEAD)`.
#
# En Render no hace falta: inyecta `RENDER_GIT_COMMIT` por su cuenta.
#
# Si queda vacío, el endpoint informa `commit: null` en vez de inventar un valor.
ARG GIT_COMMIT=""
ENV GIT_COMMIT=$GIT_COMMIT

EXPOSE 3000

CMD ["node", "src/server.js"]
