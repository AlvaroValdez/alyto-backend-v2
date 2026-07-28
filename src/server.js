/**
 * server.js — Entry Point de Alyto Backend V2.0
 *
 * Este archivo es DELIBERADAMENTE mínimo. Su única responsabilidad es garantizar
 * el orden de arranque; la aplicación entera vive en ./app.js.
 *
 * ⚠️  POR QUÉ EXISTE ESTA SEPARACIÓN (audit 2026-07-28)
 *
 * En ESM, TODOS los `import` estáticos de un módulo —y su grafo transitivo
 * completo— se evalúan ANTES de que corra la primera línea del cuerpo, incluido
 * cualquier `await` de nivel superior. Antes, este archivo importaba las ~60
 * rutas/servicios de forma estática y recién después hacía `await
 * loadSecretsIntoEnv()`. Resultado: todo módulo que leyera `process.env.X` en
 * ámbito de módulo capturaba el valor PRE-secretos, es decir, solo lo que dotenv
 * había puesto desde el .env. Toda variable que viviera ÚNICAMENTE en AWS
 * Secrets Manager era invisible para esos módulos, que caían a sus defaults
 * silenciosos (sandbox de proveedores de pago, testnet de Stellar, SendGrid sin
 * autenticar, KMS sin key ARN…).
 *
 * El `import()` DINÁMICO de la última línea se evalúa después del `await`, así
 * que app.js y todo su grafo ven process.env ya poblado. Este es el único punto
 * del código donde ese orden está garantizado: no agregar imports estáticos de
 * módulos de negocio en este archivo.
 *
 * El entry point debe seguir llamándose src/server.js — está referenciado en
 * Dockerfile, Procfile, render.yaml, ecosystem.config.cjs y package.json.
 */

// ⚠️  dotenv primero — Secrets Manager necesita AWS_REGION y AWS_SECRETS_NAME del .env
import 'dotenv/config';

// ⚠️  Secrets Manager antes que todo — inyecta el resto de vars en process.env.
// Si AWS_SECRETS_NAME está definido carga desde AWS; si no, usa .env normalmente.
import { loadSecretsIntoEnv } from './utils/awsSecrets.js';
await loadSecretsIntoEnv();

// Recién ahora, con process.env completo, se evalúa la aplicación.
const { default: app } = await import('./app.js');

export default app;
