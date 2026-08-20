/**
 * generate-landing-hero.mjs — Genera copy de hero para la landing (alyto.io) con IA.
 *
 * Pipeline de marketing (marketingCampaignService): toma un brief por flags/env,
 * llama al modelo vía el adaptador llmProvider, aplica el guard de compliance y
 * imprime las variantes (titular + subtítulo + CTA, en español). El copy es un
 * BORRADOR — revisalo y aprobalo antes de publicar.
 *
 * Requisitos: MARKETING_AI_ENABLED=true y ANTHROPIC_API_KEY (o config bedrock).
 *
 * Ejecución local:
 *   MARKETING_AI_ENABLED=true node scripts/generate-landing-hero.mjs \
 *     --audiencia "usuarios retail en Bolivia" \
 *     --objetivo "que creen su wallet" \
 *     --notas "resaltar saldo en BOB y USDC, envíos sin fricción" \
 *     --variantes 4
 *
 * Dentro del container (hereda env de Secrets Manager):
 *   docker compose exec -e MARKETING_AI_ENABLED=true alyto-backend \
 *     node scripts/generate-landing-hero.mjs --variantes 4
 *
 * Salida JSON pura (para pipe a otra herramienta): agregá --json.
 */

import 'dotenv/config';
import { loadSecretsIntoEnv } from '../src/utils/awsSecrets.js';

// Cargar Secrets Manager ANTES de importar el servicio: lee MARKETING_AI_* y
// ANTHROPIC_API_KEY al cargarse.
await loadSecretsIntoEnv();

// Parseo mínimo de flags --clave valor (y --json booleano).
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'json') { out.json = true; continue; }
    const val = argv[i + 1];
    if (val !== undefined && !val.startsWith('--')) { out[key] = val; i++; }
    else out[key] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const { generateLandingHero, isMarketingCampaignEnabled } =
  await import('../src/services/marketingCampaignService.js');

if (!isMarketingCampaignEnabled()) {
  console.error('✖ Pipeline apagado. Seteá MARKETING_AI_ENABLED=true para ejecutarlo.');
  process.exit(1);
}

const brief = {
  audiencia: args.audiencia,
  objetivo:  args.objetivo,
  notas:     args.notas,
  variantes: args.variantes,
};

const result = await generateLandingHero(brief);

if (!result) {
  console.error('✖ No se generaron variantes válidas (revisá logs por detalle: parseo, compliance o error del modelo).');
  process.exit(2);
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log(`\n🟣 Hero — ${result.items.length} variante(s) válida(s)` +
  (result.dropped?.length ? ` · ${result.dropped.length} descartada(s) por guard` : '') + '\n');

result.items.forEach((v, i) => {
  console.log(`${i + 1}. ${v.titular}`);
  console.log(`   ${v.subtitulo}`);
  console.log(`   [ ${v.cta} ]\n`);
});

if (result.usage) {
  console.log(`— tokens: ${result.usage.inputTokens ?? '?'} in / ${result.usage.outputTokens ?? '?'} out`);
}

process.exit(0);
