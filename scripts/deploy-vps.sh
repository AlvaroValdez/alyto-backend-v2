#!/usr/bin/env bash
#
# deploy-vps.sh — Despliegue de producción (VPS) de principio a fin.
#
# POR QUÉ EXISTE
#
# El 2026-10-03 un `docker compose up -d --force-recreate` dejó la API caída con
# 502 durante varios minutos. La causa no fue el código: al recrearse, los
# contenedores intercambiaron su dirección en la red de Docker (el backend pasó
# de .3 a .2 y el frontend al revés), y nginx-proxy-manager resuelve el nombre
# del upstream UNA sola vez, al cargar su configuración, y lo cachea. Siguió
# mandando el tráfico de api.alyto.app a la dirección vieja, que para entonces
# era el contenedor del frontend:
#
#   connect() failed (111: Connection refused) ... upstream: "http://172.18.0.3:3000/..."
#
# El arreglo es recargar nginx después de recrear. Es un paso que se olvida
# justamente porque el despliegue "parece" haber salido bien: los contenedores
# levantan sanos y el fallo solo se ve desde fuera. Por eso va en un script con
# una comprobación de salud al final, y no en un apunte de la bitácora.
#
# USO (en el VPS, como el usuario alyto):
#   ~/alyto-v2/scripts/deploy-vps.sh              # backend + frontend
#   ~/alyto-v2/scripts/deploy-vps.sh backend      # solo uno de los dos
#   ~/alyto-v2/scripts/deploy-vps.sh frontend
#
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-$HOME/alyto-v2}"
FRONTEND_SRC="${FRONTEND_SRC:-/home/alyto/alyto-frontend-v2}"
PROXY_CONTAINER="${PROXY_CONTAINER:-nginx-proxy-manager}"
API_HEALTH_URL="${API_HEALTH_URL:-https://api.alyto.app/api/health}"
SITE_URL="${SITE_URL:-https://alyto.app}"

OBJETIVO="${1:-todo}"
case "$OBJETIVO" in
  todo)     SERVICIOS=(alyto-backend alyto-frontend) ;;
  backend)  SERVICIOS=(alyto-backend) ;;
  frontend) SERVICIOS=(alyto-frontend) ;;
  *) echo "Uso: $0 [todo|backend|frontend]" >&2; exit 2 ;;
esac

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ── 1. Traer el código ────────────────────────────────────────────────────────
# El frontend se construye desde su propio árbol (context en el compose), así que
# un `git pull` solo en el backend NO actualiza la interfaz.
if [[ " ${SERVICIOS[*]} " == *" alyto-backend "* ]]; then
  log "Actualizando backend ($COMPOSE_DIR)"
  git -C "$COMPOSE_DIR" pull --ff-only origin main
  git -C "$COMPOSE_DIR" log -1 --format='    %h %s'
fi
if [[ " ${SERVICIOS[*]} " == *" alyto-frontend "* ]]; then
  log "Actualizando frontend ($FRONTEND_SRC)"
  git -C "$FRONTEND_SRC" pull --ff-only origin main
  git -C "$FRONTEND_SRC" log -1 --format='    %h %s'
fi

# ── 2. Construir ──────────────────────────────────────────────────────────────
# `up` por sí solo reutiliza la imagen existente: sin `build` el despliegue no
# incluye ningún cambio de código.
log "Construyendo imágenes: ${SERVICIOS[*]}"
docker compose -f "$COMPOSE_DIR/docker-compose.yml" --project-directory "$COMPOSE_DIR" \
  build "${SERVICIOS[@]}"

# ── 3. Recrear ────────────────────────────────────────────────────────────────
log "Recreando contenedores"
docker compose -f "$COMPOSE_DIR/docker-compose.yml" --project-directory "$COMPOSE_DIR" \
  up -d --force-recreate "${SERVICIOS[@]}"

# ── 4. Recargar el proxy ──────────────────────────────────────────────────────
# El paso cuya omisión tiró producción. Recargar hace que nginx vuelva a resolver
# los nombres de los upstreams contra el DNS de Docker.
log "Recargando nginx en $PROXY_CONTAINER (re-resolver IPs de los upstreams)"
if docker ps --format '{{.Names}}' | grep -qx "$PROXY_CONTAINER"; then
  docker exec "$PROXY_CONTAINER" nginx -s reload
  sleep 3
else
  echo "    ⚠️  No se encontró el contenedor '$PROXY_CONTAINER'." >&2
  echo "    ⚠️  Recarga el proxy a mano o la API quedará con 502." >&2
fi

# ── 5. Comprobar desde fuera ──────────────────────────────────────────────────
# Desde dentro del VPS los contenedores se ven sanos aunque el proxy esté
# apuntando mal: la comprobación tiene que atravesar el mismo camino que un
# usuario real. Sin esto, el 502 lo descubre un cliente.
log "Comprobando salud a través del proxy"
fallos=0
comprobar() {
  local nombre="$1" url="$2" code
  for intento in 1 2 3 4 5 6; do
    code=$(curl -sL -o /dev/null -w '%{http_code}' -m 10 "$url" || echo 000)
    if [[ "$code" == "200" ]]; then
      printf '    ✅ %-10s %s -> %s\n' "$nombre" "$url" "$code"
      return 0
    fi
    sleep 5
  done
  printf '    ❌ %-10s %s -> %s\n' "$nombre" "$url" "$code" >&2
  fallos=$((fallos + 1))
}

[[ " ${SERVICIOS[*]} " == *" alyto-backend "*  ]] && comprobar "API"      "$API_HEALTH_URL"
[[ " ${SERVICIOS[*]} " == *" alyto-frontend "* ]] && comprobar "Sitio"    "$SITE_URL"

if (( fallos > 0 )); then
  echo >&2
  echo "❌ El despliegue dejó servicios sin responder desde fuera." >&2
  echo "   Revisa:  docker logs alyto-app --tail 50" >&2
  echo "            docker exec $PROXY_CONTAINER tail -20 /data/logs/proxy-host-3_error.log" >&2
  exit 1
fi

log "Despliegue completado"
docker ps --format '    {{.Names}}\t{{.Status}}'
