#!/usr/bin/env node
/**
 * facebook-page-token.mjs — Obtiene un Page Access Token PERMANENTE.
 *
 * El token que devuelve el Graph API Explorer es de corta duración (1-2 horas),
 * y el token de página derivado de él hereda ese vencimiento. Para uno que no
 * expire hay que dar un paso intermedio:
 *
 *   token de usuario corto  →  token de usuario largo (60 días)  →  token de
 *   página PERMANENTE (expires_at = 0)
 *
 * El paso del medio es el que casi todos se saltan, y es el que hace que el
 * token de página no expire nunca.
 *
 * ── Uso ──────────────────────────────────────────────────────────────────────
 *
 * 1. En el panel de la app de Meta → Configuración → Básica, copiá la
 *    "Clave secreta de la app".
 * 2. En developers.facebook.com/tools/explorer generá un token de USUARIO con
 *    los permisos pages_show_list, pages_read_engagement, pages_manage_posts.
 * 3. Agregá al .env estas DOS variables temporales:
 *
 *      FACEBOOK_APP_SECRET=...
 *      FACEBOOK_USER_TOKEN_CORTO=...
 *
 * 4. Corré:  node scripts/facebook-page-token.mjs
 *
 *    El script escribe FACEBOOK_PAGE_ACCESS_TOKEN en el .env y NO imprime
 *    ningún token en pantalla.
 *
 * 5. BORRÁ del .env las dos variables temporales del paso 3. El script te lo
 *    recuerda al terminar.
 *
 * Requiere además FACEBOOK_PAGE_ID (la página a la que se publica) y
 * FACEBOOK_APP_ID. Si el app id no está, se deduce del token.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';

const GRAPH = `https://graph.facebook.com/${process.env.FACEBOOK_GRAPH_VERSION || 'v21.0'}`;
const ENV_PATH = process.env.ENV_PATH || '.env';

const fail = (msg) => { console.error(`\n❌ ${msg}\n`); process.exit(1); };
const get = async (path) => {
  const r = await fetch(`${GRAPH}${path}`);
  const d = await r.json();
  if (d.error) fail(`Meta: ${d.error.message}`);
  return d;
};

// ── Validación de entrada ─────────────────────────────────────────────────────

const secret     = process.env.FACEBOOK_APP_SECRET;
const userCorto  = process.env.FACEBOOK_USER_TOKEN_CORTO;
const pageId     = process.env.FACEBOOK_PAGE_ID;

if (!secret)    fail('Falta FACEBOOK_APP_SECRET en el .env (panel de Meta → Configuración → Básica).');
if (!userCorto) fail('Falta FACEBOOK_USER_TOKEN_CORTO en el .env (Graph API Explorer → token de usuario).');
if (!pageId)    fail('Falta FACEBOOK_PAGE_ID en el .env.');

// El app id se deduce del propio token si no está configurado.
let appId = process.env.FACEBOOK_APP_ID;
if (!appId) {
  const dbg = await get(`/debug_token?input_token=${encodeURIComponent(userCorto)}&access_token=${encodeURIComponent(userCorto)}`);
  appId = dbg?.data?.app_id;
  if (!appId) fail('No se pudo deducir FACEBOOK_APP_ID; agregalo al .env.');
  console.log(`app id deducido del token: ${appId}`);
}

// ── Paso 1: token de usuario de larga duración ────────────────────────────────

console.log('\n1/3 · intercambiando el token de usuario por uno de larga duración…');
const largo = await get(
  `/oauth/access_token?grant_type=fb_exchange_token` +
  `&client_id=${encodeURIComponent(appId)}` +
  `&client_secret=${encodeURIComponent(secret)}` +
  `&fb_exchange_token=${encodeURIComponent(userCorto)}`,
);
if (!largo.access_token) fail('Meta no devolvió el token de larga duración.');
console.log(`    ok · vence en ${largo.expires_in ? Math.round(largo.expires_in / 86400) + ' días' : '(sin dato)'}`);

// ── Paso 2: token de página derivado del token largo ──────────────────────────

console.log('2/3 · pidiendo el token de la página…');
const cuentas = await get(`/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(largo.access_token)}`);
const pagina = (cuentas.data || []).find(p => p.id === pageId);
if (!pagina) {
  const listado = (cuentas.data || []).map(p => `${p.name} (${p.id})`).join(', ') || '(ninguna)';
  fail(`La página ${pageId} no aparece entre las accesibles. Disponibles: ${listado}`);
}
if (!pagina.access_token) fail('Meta no devolvió token para esa página.');
console.log(`    ok · ${pagina.name}`);

// ── Paso 3: verificar que efectivamente no expira ─────────────────────────────

console.log('3/3 · verificando el vencimiento…');
const dbg = await get(`/debug_token?input_token=${encodeURIComponent(pagina.access_token)}&access_token=${encodeURIComponent(pagina.access_token)}`);
const d = dbg.data || {};
const permanente = d.expires_at === 0;

console.log(`    tipo    : ${d.type}`);
console.log(`    vence   : ${permanente ? 'NUNCA ✅' : new Date(d.expires_at * 1000).toISOString() + ' ⚠️'}`);
console.log(`    permisos: ${(d.scopes || []).join(', ')}`);

if (!permanente) {
  console.warn('\n⚠️  El token sigue teniendo vencimiento. Causa habitual: el token de usuario');
  console.warn('    del paso 2 ya había expirado, o no incluía los tres permisos de página.');
  console.warn('    Generá uno nuevo en el Graph API Explorer y volvé a correr el script.');
}

// ── Escritura en el .env, sin imprimir el valor ───────────────────────────────

const antes = readFileSync(ENV_PATH, 'utf8');
const linea = `FACEBOOK_PAGE_ACCESS_TOKEN=${pagina.access_token}`;
const despues = /^FACEBOOK_PAGE_ACCESS_TOKEN=.*$/m.test(antes)
  ? antes.replace(/^FACEBOOK_PAGE_ACCESS_TOKEN=.*$/m, linea)
  : `${antes.replace(/\n?$/, '\n')}${linea}\n`;
writeFileSync(ENV_PATH, despues);

console.log(`\n✅ FACEBOOK_PAGE_ACCESS_TOKEN escrito en ${ENV_PATH} (${pagina.access_token.length} chars).`);
console.log('\n⚠️  Ahora BORRÁ del .env estas dos variables, que ya no se necesitan:');
console.log('      FACEBOOK_APP_SECRET');
console.log('      FACEBOOK_USER_TOKEN_CORTO');
console.log('\n    Y guardá el token de página en tu gestor de secretos (o AWS Secrets');
console.log('    Manager) antes de perderlo: regenerarlo exige repetir todo este flujo.\n');
