/**
 * notificationTypes.test.js — Todo tipo que el código emite debe estar declarado.
 *
 * `notify()` persiste la notificación y, si falla, registra el error y continúa
 * para no bloquear el flujo de negocio. Esa decisión es correcta, pero convierte
 * un tipo no declarado en una pérdida silenciosa: el push de FCM sale igual
 * (va después y por otra vía), así que desde fuera parece que todo funciona
 * mientras la campana de la aplicación no recibe nada.
 *
 * Así es como se perdieron, sin que nadie lo notara: las cuatro notificaciones de
 * verificación de identidad —aprobación incluida— y dos avisos sobre dinero
 * (`admin_disbursement_stuck`, `treasury_funding_unmatched`).
 *
 * Esta prueba compara lo que el código emite contra lo que el esquema acepta. Es
 * una comprobación estática a propósito: el fallo real no lanza, así que no hay
 * ninguna prueba de comportamiento que lo delate.
 */
import '../setup.env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC  = path.join(raiz, 'src');

/** Tipos declarados en el enum del esquema. */
function tiposDeclarados() {
  const src   = fs.readFileSync(path.join(SRC, 'models/Notification.js'), 'utf8');
  const desde = src.indexOf('enum: [');
  const bloque = src.slice(desde, src.indexOf(']', desde));
  return new Set([...bloque.matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
}

/** Tipos que el código pasa a notify()/notifyAdmins() vía `data: { type: '...' }`. */
function tiposEmitidos() {
  const encontrados = new Map();   // tipo → archivos que lo emiten
  const recorrer = (dir) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const ruta = path.join(dir, entrada.name);
      if (entrada.isDirectory()) { recorrer(ruta); continue; }
      if (!entrada.name.endsWith('.js')) continue;
      const contenido = fs.readFileSync(ruta, 'utf8');
      for (const m of contenido.matchAll(/data:\s*\{\s*type:\s*'([a-z_]+)'/g)) {
        const rel = path.relative(raiz, ruta);
        encontrados.set(m[1], [...(encontrados.get(m[1]) ?? []), rel]);
      }
    }
  };
  recorrer(SRC);
  return encontrados;
}

describe('enum de Notification.type', () => {

  it('declara todos los tipos que el código emite', () => {
    const declarados = tiposDeclarados();
    const emitidos   = tiposEmitidos();

    const huerfanos = [...emitidos.entries()]
      .filter(([tipo]) => !declarados.has(tipo))
      .map(([tipo, archivos]) => `  '${tipo}' emitido en ${archivos.join(', ')}`);

    expect(huerfanos.join('\n') || 'ninguno').toBe('ninguno');
  });

  it('cubre la verificación de identidad, que es donde se detectó el agujero', () => {
    const declarados = tiposDeclarados();
    for (const tipo of ['kyc_approved', 'kyc_rejected', 'kyc_recoverable', 'kyc_retry_nudge']) {
      expect(declarados.has(tipo)).toBe(true);
    }
  });

  it('cubre los avisos sobre dinero dirigidos a administración', () => {
    const declarados = tiposDeclarados();
    for (const tipo of ['admin_disbursement_stuck', 'treasury_funding_unmatched']) {
      expect(declarados.has(tipo)).toBe(true);
    }
  });
});
