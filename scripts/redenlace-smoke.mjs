#!/usr/bin/env node
/**
 * redenlace-smoke.mjs — Primer contacto real con el sandbox de ATC (Red Enlace).
 *
 * Valida, en orden, las tres cosas que la documentación no puede confirmar:
 *   1. que las credenciales del portal autentican contra la URL base configurada
 *   2. que el QR se genera con nuestro establecimiento y nuestra vigencia
 *   3. que la consulta de estado devuelve el QR recién creado
 *
 * No mueve dinero: generar un QR no debita ni acredita nada. El único efecto es
 * un QR pendiente en el sandbox de ATC, que expira solo.
 *
 * Uso:
 *   node scripts/redenlace-smoke.mjs                 # monto 1.00 BOB
 *   node scripts/redenlace-smoke.mjs --monto 5.50
 *   node scripts/redenlace-smoke.mjs --png /tmp/qr.png   # guarda el QR para pagarlo
 *   node scripts/redenlace-smoke.mjs --estado 153980     # solo consulta un QR
 *
 * ⚠️ No imprime credenciales. De cada secreto reporta solo si está presente y
 * cuántos caracteres tiene: alcanza para diagnosticar un copy/paste cortado sin
 * dejar el valor en la terminal ni en el historial.
 */

import 'dotenv/config';
import fs from 'node:fs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const ok   = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const bad  = (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`  ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

/** Reporta presencia y longitud. Nunca el valor. */
function reportSecret(name) {
  const v = process.env[name];
  if (!v) { bad(`${name} — ausente`); return false; }
  ok(`${name} — presente (${v.length} caracteres)`);
  return true;
}

function reportPlain(name, { required = true } = {}) {
  const v = process.env[name];
  if (!v) { (required ? bad : info)(`${name} — ausente`); return !required; }
  ok(`${name} = ${v}`);
  return true;
}

async function main() {
  head('1. Configuración');

  const base = (process.env.REDENLACE_BASE_URL ?? '').replace(/\/+$/, '');
  let listo = true;
  listo &= reportPlain('REDENLACE_BASE_URL');
  listo &= reportSecret('REDENLACE_CLIENT_ID');
  listo &= reportSecret('REDENLACE_CLIENT_SECRET');
  listo &= reportPlain('REDENLACE_ESTABLISHMENT_ID');
  reportPlain('REDENLACE_ESTABLISHMENT_NAME', { required: false });
  reportPlain('REDENLACE_QR_WEBHOOK_URL',     { required: false });
  reportSecret('REDENLACE_QR_WEBHOOK_VALUE');

  if (!base.startsWith('https://')) {
    bad('La URL base no usa https. No se manda el client_secret por texto claro.');
    process.exit(1);
  }
  if (base.includes('api.redenlace.com.bo')) {
    bad('La URL base apunta a PRODUCCIÓN. Este script es para sandbox. Abortando.');
    process.exit(1);
  }
  if (!listo) { bad('Faltan variables. Abortando.'); process.exit(1); }

  // ── Auth ───────────────────────────────────────────────────────────────────
  head('2. Autenticación OAuth 2.0');

  const basic = Buffer
    .from(`${process.env.REDENLACE_CLIENT_ID}:${process.env.REDENLACE_CLIENT_SECRET}`, 'utf8')
    .toString('base64');

  const authRes = await fetch(
    `${base}/oauth-client-credentials/access-token?grant_type=client_credentials`,
    {
      method:  'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    '',
    },
  );

  if (!authRes.ok) {
    bad(`HTTP ${authRes.status} al autenticar`);
    // El body de un 4xx de auth puede reflejar la petición recibida, con el
    // Basic adentro. Solo reportamos el tamaño.
    const body = await authRes.text().catch(() => '');
    info(`respuesta de ${body.length} caracteres (no se imprime: puede contener el Basic)`);
    process.exit(1);
  }

  const auth = await authRes.json();
  if (!auth?.access_token) { bad('Respuesta sin access_token'); process.exit(1); }

  ok(`Token obtenido (${String(auth.access_token).length} caracteres)`);
  info(`expires_in: ${auth.expires_in} s · scope: ${auth.scope ?? '(no informado)'}`);

  const headers = {
    'Content-Type': 'application/json',
    'access_token': auth.access_token,
    'client_id':    process.env.REDENLACE_CLIENT_ID,
  };

  // ── Solo consulta ──────────────────────────────────────────────────────────
  const soloEstado = arg('estado');
  if (soloEstado) {
    head(`3. Estado del QR ${soloEstado}`);
    const r = await fetch(`${base}/qr/simple/v2/verify/${encodeURIComponent(soloEstado)}`, { headers });
    const d = await r.json().catch(() => null);
    console.log(JSON.stringify(d, null, 2));
    process.exit(d?.success === true ? 0 : 1);
  }

  // ── Generación ─────────────────────────────────────────────────────────────
  head('3. Generación de QR');

  const monto = Number(arg('monto', '1.00'));
  // Dos restricciones que NO están documentadas, ambas verificadas contra el
  // sandbox el 2026-09-26:
  //   - solo dígitos          → INVALID_FORMAT ante `SMOKE74332707`
  //   - entra en un int32     → `For input string: "9475146471"` (parseInt de Java)
  // De ahí 9 dígitos: el máximo posible (999.999.999) queda bajo 2.147.483.647.
  const referencia = `9${Date.now().toString().slice(-8)}`;
  const vigencia   = Number(process.env.REDENLACE_QR_VIGENCIA_SECONDS ?? 600);

  const body = {
    glosa:                 'Prueba de integracion Alyto',
    moneda:                'BOB',
    monto:                 Number(monto.toFixed(2)),
    numeroReferencia:      referencia,
    vigencia,
    idEstablecimiento:     Number(process.env.REDENLACE_ESTABLISHMENT_ID),
    nombreEstablecimiento: process.env.REDENLACE_ESTABLISHMENT_NAME ?? 'Alyto',
  };

  if (process.env.REDENLACE_QR_WEBHOOK_URL && process.env.REDENLACE_QR_WEBHOOK_VALUE) {
    body.webhook = {
      url:   process.env.REDENLACE_QR_WEBHOOK_URL,
      key:   process.env.REDENLACE_QR_WEBHOOK_KEY ?? 'x-api-key',
      value: process.env.REDENLACE_QR_WEBHOOK_VALUE,
    };
    info(`webhook → ${body.webhook.url} (cabecera ${body.webhook.key})`);
  } else {
    info('sin webhook: el pago no se va a notificar, solo se podrá consultar el estado');
  }

  info(`referencia propia: ${referencia} · monto: ${monto} BOB · vigencia: ${vigencia} s`);

  const genRes = await fetch(`${base}/qr/simple/v2/generate`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const gen = await genRes.json().catch(() => null);

  if (!genRes.ok || gen?.success !== true) {
    bad(`Generación fallida (HTTP ${genRes.status})`);
    console.log(JSON.stringify(gen, null, 2));
    // La vigencia es el sospechoso número uno: su máximo no está documentado.
    const texto = JSON.stringify(gen ?? {}).toLowerCase();
    if (texto.includes('vigencia')) {
      info('→ probá bajando REDENLACE_QR_VIGENCIA_SECONDS. El ejemplo del portal usa 45.');
    }
    if (texto.includes('referencia')) {
      info('→ numeroReferencia admite SOLO dígitos (verificado en sandbox 2026-09-26).');
    }
    if (texto.includes('for input string')) {
      info('→ es un NumberFormatException de Java: la referencia debe entrar en');
      info('  un int de 32 bits con signo (máximo 2.147.483.647), no solo en 10 dígitos.');
    }
    process.exit(1);
  }

  const d = gen.data;
  ok('QR generado');
  info(`numeroReferencia de ATC : ${d.numeroReferencia}   ← esto es lo que guardamos como qrId`);
  info(`referencia nuestra      : ${d.numeroReferenciaOriginante ?? '(no devuelta)'}`);
  info(`estado                  : ${d.estado}`);
  info(`expira                  : ${d.fechaExpiracion}`);

  // La vigencia real manda sobre BANK_QR_DUE_DAYS. Si ATC la recorta, hay que
  // enterarse acá y no cuando un usuario mire un QR muerto.
  if (d.fechaExpiracion) {
    const segundos = Math.round((new Date(d.fechaExpiracion) - Date.now()) / 1000);
    const aviso    = Math.abs(segundos - vigencia) > 60 ? '  ⚠️ ATC NO respetó la vigencia pedida' : '';
    info(`vigencia efectiva       : ~${segundos} s${aviso}`);
  }

  const png = arg('png');
  if (png && d.qr) {
    fs.writeFileSync(png, Buffer.from(d.qr, 'base64'));
    ok(`Imagen guardada en ${png} (PNG, no SVG)`);
    info('Escaneala con tu app bancaria para probar el webhook de punta a punta.');
  } else if (d.qr) {
    info(`imagen: ${d.qr.length} caracteres en base64 (usá --png para guardarla)`);
  }

  // ── Consulta inmediata ─────────────────────────────────────────────────────
  head('4. Consulta de estado');

  const verRes = await fetch(`${base}/qr/simple/v2/verify/${encodeURIComponent(d.numeroReferencia)}`, { headers });
  const ver    = await verRes.json().catch(() => null);

  if (ver?.success !== true) {
    bad('La consulta falló sobre un QR que acabamos de crear');
    console.log(JSON.stringify(ver, null, 2));
    process.exit(1);
  }

  ok(`Estado consultado: ${ver.data.estado}`);
  info(`importe: ${ver.data.importe} ${ver.data.moneda}`);

  head('Resultado');
  ok('Autenticación, generación y consulta funcionan contra el sandbox.');
  info(`Para seguir el QR:  node scripts/redenlace-smoke.mjs --estado ${d.numeroReferencia}`);
}

main().catch((err) => {
  bad(err.message);
  process.exit(1);
});
