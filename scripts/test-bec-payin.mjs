#!/usr/bin/env node
/**
 * test-bec-payin.mjs — Verificación end-to-end del payin BANECO QR Connect (Pago Simple)
 *
 * Valida la integración de cobros con credenciales REALES, en un solo comando. Pensado
 * para correr el día que BANECO entregue las credenciales de API (usuario, contraseña,
 * llave AES) — confirma que todo el camino de payin funciona ANTES de exponerlo a usuarios.
 *
 * Pasos:
 *   1. Reporta qué variables BEC están configuradas (enmascaradas).
 *   2. verifyCipher('1234') — confirma que nuestro AES-256-CBC es compatible con el banco.
 *   3. generateQR (monto mínimo) — genera un QR real de cobro y guarda la imagen.
 *   4. getQRStatus — consulta el estado del QR recién creado (debe ser 'pending').
 *   5. (opcional) cancelQR — anula el QR de prueba para no dejar basura.
 *
 * Lo que NO puede automatizar (requiere humano + webhook registrado):
 *   - El pago real del QR desde una app bancaria.
 *   - La recepción del IPN notifyPaymentQR (validar registrando la URL con el banco).
 *
 * Uso:
 *   node scripts/test-bec-payin.mjs                # genera QR de 1 BOB y NO lo cancela
 *   node scripts/test-bec-payin.mjs --amount 5     # monto personalizado
 *   node scripts/test-bec-payin.mjs --cancel       # cancela el QR al terminar
 *   node scripts/test-bec-payin.mjs --cipher-only  # solo valida auth + cifrado
 *
 * Variables requeridas (env / Secrets Manager):
 *   BEC_BASE_URL  BEC_USERNAME  BEC_PASSWORD  BEC_AES_KEY  BEC_ACCOUNT_CREDIT
 *   (BEC_MOCK_ENABLED debe NO estar en 'true' para probar contra el banco real)
 */

import fs from 'fs';
import path from 'path';
import * as bec from '../src/services/bankQr/banks/becQrService.js';

const args   = process.argv.slice(2);
const has    = (f) => args.includes(f);
const getArg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const amount      = Number(getArg('--amount', '1'));
const cancelAfter = has('--cancel');
const cipherOnly  = has('--cipher-only');

function mask(v) {
  if (!v) return '(no configurada)';
  if (v.length <= 6) return '***';
  return `${v.slice(0, 3)}…${v.slice(-2)} (len ${v.length})`;
}

function fmtDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function main() {
  console.log('\n=== BEC Payin — Verificación de integración ===\n');

  // 1. Reporte de configuración
  console.log('1) Variables BEC:');
  console.log('   BEC_BASE_URL       =', process.env.BEC_BASE_URL ?? '(default desa)');
  console.log('   BEC_USERNAME       =', mask(process.env.BEC_USERNAME));
  console.log('   BEC_PASSWORD       =', mask(process.env.BEC_PASSWORD));
  console.log('   BEC_AES_KEY        =', mask(process.env.BEC_AES_KEY));
  console.log('   BEC_ACCOUNT_CREDIT =', mask(process.env.BEC_ACCOUNT_CREDIT));
  console.log('   BEC_MOCK_ENABLED   =', process.env.BEC_MOCK_ENABLED ?? '(no)');

  if (process.env.BEC_AES_KEY && Buffer.from(process.env.BEC_AES_KEY, 'utf8').length !== 32) {
    console.warn('   ⚠️  BEC_AES_KEY no mide 32 bytes — AES-256 requiere exactamente 32 bytes.');
  }
  if (!bec.isAvailable()) {
    console.error('\n❌ Faltan credenciales BEC. Configura las variables y reintenta.');
    process.exit(1);
  }
  if (String(process.env.BEC_MOCK_ENABLED).toLowerCase() === 'true') {
    console.warn('\n⚠️  BEC_MOCK_ENABLED=true → se está en mock. Para probar contra el banco real, quítalo.');
  }

  // 2. Validación de cifrado contra el banco
  console.log('\n2) verifyCipher("1234") contra el banco…');
  try {
    const r = await bec.verifyCipher('1234');
    console.log('   encrypted =', r.encrypted);
    console.log('   decrypted =', r.decrypted);
    console.log(r.match ? '   ✅ Cifrado compatible con el banco.' : '   ❌ El banco NO descifró a "1234" — revisar BEC_AES_KEY.');
    if (!r.match) process.exit(2);
  } catch (err) {
    console.error('   ❌ Error en verifyCipher:', err.message);
    process.exit(2);
  }

  if (cipherOnly) { console.log('\n✅ Auth + cifrado OK (--cipher-only). Fin.\n'); return; }

  // 3. Generar QR de cobro
  console.log(`\n3) generateQR — cobro de ${amount} BOB…`);
  const txId = `TEST-${Date.now()}`;
  let qr;
  try {
    qr = await bec.generateQR({
      transactionId: txId,
      amount,
      currency:    'BOB',
      description: 'Prueba de integración Alyto (cancelar)',
      dueDate:     fmtDate(new Date()),
    });
    console.log('   ✅ QR generado. qrId =', qr.qrId);
    if (qr.qrImage) {
      const out = path.join(process.cwd(), `bec-test-qr-${qr.qrId}.png`);
      fs.writeFileSync(out, Buffer.from(qr.qrImage, 'base64'));
      console.log('   🖼️  Imagen guardada:', out, '(escanéala con una app bancaria para probar el pago real)');
    }
  } catch (err) {
    console.error('   ❌ Error en generateQR:', err.message);
    process.exit(3);
  }

  // 4. Consultar estado
  console.log('\n4) getQRStatus…');
  try {
    const s = await bec.getQRStatus(qr.qrId);
    console.log('   status =', s.status, '(esperado: pending)');
  } catch (err) {
    console.error('   ❌ Error en getQRStatus:', err.message);
  }

  // 5. Cancelar (opcional)
  if (cancelAfter) {
    console.log('\n5) cancelQR…');
    try { await bec.cancelQR(qr.qrId); console.log('   ✅ QR de prueba anulado.'); }
    catch (err) { console.error('   ❌ Error en cancelQR:', err.message); }
  } else {
    console.log('\n5) (sin --cancel) — el QR queda activo para que pruebes un pago real + IPN.');
  }

  console.log('\n✅ Verificación de payin completada.\n');
  console.log('Pendiente manual: registrar el webhook notifyPaymentQR con BANECO');
  console.log('  → https://api.alyto.app/api/v1/ipn/bec  (prod)  |  staging: la URL de Render');
  console.log('  y pagar el QR generado para confirmar que el IPN llega y confirma la tx.\n');
}

main().catch((err) => { console.error('Error fatal:', err); process.exit(99); });
