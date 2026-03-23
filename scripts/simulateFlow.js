/**
 * simulateFlow.js — Simulación E2E del Corredor de Pagos Alyto V2.0
 *
 * Ejecuta un flujo completo de transferencia transfronteriza sin levantar
 * el servidor HTTP, interactuando directamente con los servicios y modelos.
 *
 * Flujo simulado:
 *   [Pay-in Chile/SpA] → [Tránsito Stellar] → [Liquidación Bolivia/SRL]
 *
 *   payin_pending → payin_completed → in_transit → completed + PDF
 *
 * Estados rastreados para el resumen final:
 *   1. payin_pending     — Transacción creada, esperando confirmación Fintoc
 *   2. payin_completed   — Fiat recibido en cuenta SpA (webhook Fintoc simulado)
 *   3. in_transit        — USDC en tránsito en Stellar Network
 *   4. completed         — Liquidado en Bolivia + Comprobante Oficial generado
 *
 * Uso:
 *   node scripts/simulateFlow.js
 *
 * COMPLIANCE: Terminología prohibida ausente. Cero uso de palabras restringidas.
 */

import 'dotenv/config';
import fs        from 'fs';
import path      from 'path';
import mongoose  from 'mongoose';
import { fileURLToPath } from 'url';

// ── Modelos ───────────────────────────────────────────────────────────────────
import User        from '../src/models/User.js';
import Transaction from '../src/models/Transaction.js';

// ── Servicios ─────────────────────────────────────────────────────────────────
import { executeWeb3Transit }      from '../src/services/stellarService.js';
import { generateOfficialReceipt } from '../src/utils/pdfGenerator.js';

// ─────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// TXID de Stellar simulado (se usa si la cuenta Testnet no está fondeada)
const SIMULATED_STELLAR_TXID =
  'a3f7c8d2e1b94f2a1d5e6c7b8a9f0e3d2c1b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8';

// Registro de estados para el resumen final
const stateHistory = [];

function logState(step, status, detail = '') {
  const ts = new Date().toISOString();
  stateHistory.push({ step, status, ts, detail });
  const icon = status.includes('failed') ? '✗' : '✓';
  console.log(`\n  ${icon}  [${step}] ${status}${detail ? '  →  ' + detail : ''}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK REQ/RES — permite llamar a los controladores Express sin servidor HTTP
// ─────────────────────────────────────────────────────────────────────────────

function createMockRequest(body = {}) {
  return { body };
}

/**
 * Crea un objeto res() compatible con Express.
 * Captura el status code, headers y body (JSON o Buffer) sin enviar HTTP.
 */
function createMockResponse() {
  const res = {
    _statusCode: null,
    _headers:    {},
    _body:       null,
    _isEnded:    false,

    status(code) {
      this._statusCode = code;
      return this;
    },
    json(data) {
      this._body    = data;
      this._isEnded = true;
      return this;
    },
    send(data) {
      this._body    = data;
      this._isEnded = true;
      return this;
    },
    setHeader(key, value) {
      this._headers[key] = value;
      return this;
    },
    // Express 5 también usa end()
    end() {
      this._isEnded = true;
      return this;
    },
  };
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Espera hasta que una transacción alcance el estado esperado (polling simple). */
async function waitForStatus(transactionId, expectedStatus, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const tx = await Transaction.findById(transactionId).lean();
    if (tx?.status === expectedStatus) return tx;
    await new Promise(r => setTimeout(r, 500)); // 500ms entre intentos
  }
  const tx = await Transaction.findById(transactionId).lean();
  return tx; // Retornar estado actual aunque no sea el esperado
}

function printBanner(title) {
  console.log('\n' + '═'.repeat(62));
  console.log(`  ${title}`);
  console.log('═'.repeat(62));
}

function printSection(title) {
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  ▶  ${title}`);
  console.log('─'.repeat(62));
}

// ─────────────────────────────────────────────────────────────────────────────
// SCRIPT PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

async function runSimulation() {
  printBanner('Alyto V2.0 — Simulación E2E de Flujo Transfronterizo');
  console.log('  Corredor: Chile (SpA/Fintoc) → Stellar → Bolivia (SRL)');

  let testUser        = null;
  let testTransaction = null;
  let finalPdfPath    = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // SETUP — Conexión a MongoDB
  // ═══════════════════════════════════════════════════════════════════════════
  printSection('SETUP — Conectando a MongoDB');

  const mongoUri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/alyto-v2';
  try {
    await mongoose.connect(mongoUri);
    console.log(`  ✓  MongoDB conectado: ${mongoUri.replace(/\/\/.*@/, '//<credentials>@')}`);
  } catch (err) {
    console.error(`  ✗  No se pudo conectar a MongoDB: ${err.message}`);
    console.error('     Asegúrate de que MongoDB esté corriendo y MONGODB_URI esté en .env');
    process.exit(1);
  }

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // MOCK USER — Usuario de prueba (AV Finance SpA — Chile)
    // ═══════════════════════════════════════════════════════════════════════
    printSection('MOCK USER — Creando usuario de prueba [SpA / Chile]');

    testUser = await User.create({
      firstName:    'Ana',
      lastName:     'Prueba Simulación',
      email:        `sim.test.${Date.now()}@alyto-test.internal`,
      legalEntity:  'SpA',
      clientType:   'personal',
      kycStatus:    'approved',
      residenceCountry: 'CL',
      identityDocument: {
        type:           'rut',
        number:         '12.345.678-9',
        issuingCountry: 'CL',
      },
      // Wallet Stellar de prueba (Testnet — cuenta no fondeada, solo para simulación)
      stellarAccount: {
        publicKey:      process.env.STELLAR_SPA_PUBLIC_KEY ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        createdByAlyto: true,
      },
    });

    console.log(`  ✓  Usuario creado: ${testUser.email}`);
    console.log(`     ID: ${testUser._id}`);
    console.log(`     Entidad: ${testUser.legalEntity} | KYC: ${testUser.kycStatus}`);

    // ═══════════════════════════════════════════════════════════════════════
    // PASO 1 — PAY-IN (Fintoc simulado)
    // Simula lo que initiateFintocPayin haría tras llamar a Fintoc API.
    // No llamamos a la API real de Fintoc — creamos el registro directamente.
    // ═══════════════════════════════════════════════════════════════════════
    printSection('PASO 1 — Pay-in Fintoc [SpA / Chile / CLP]');

    const MONTO_CLP          = 150_000;  // CLP
    const FINTOC_PI_ID_MOCK  = `pi_sim_${Date.now()}`;
    const alytoTransactionId = `ALY-B-${Date.now()}-SIM01`;

    testTransaction = await Transaction.create({
      userId:          testUser._id,
      legalEntity:     'SpA',
      operationType:   'crossBorderPayment',
      routingScenario: 'B',

      originalAmount:  MONTO_CLP,
      originCurrency:  'CLP',
      originCountry:   'CL',

      feeBreakdown: {
        alytoFee:    750,    // 0.5% de 150.000 CLP
        providerFee: 300,
        totalFee:    1050,
        feeCurrency: 'CLP',
      },

      providersUsed: ['payin:fintoc'],
      paymentLegs: [{
        stage:      'payin',
        provider:   'fintoc',
        status:     'pending',
        externalId: FINTOC_PI_ID_MOCK,
      }],

      status:              'payin_pending',
      alytoTransactionId,
    });

    logState('Paso 1', 'payin_pending', `Monto: ${MONTO_CLP.toLocaleString()} CLP | Fintoc PI: ${FINTOC_PI_ID_MOCK}`);

    // ═══════════════════════════════════════════════════════════════════════
    // PASO 2 — TRIGGER WEB3
    // Simula la recepción del webhook exitoso de Fintoc:
    //   a) Fiat recibido → actualizar a payin_completed
    //   b) Disparar stellarService.executeWeb3Transit()
    // ═══════════════════════════════════════════════════════════════════════
    printSection('PASO 2 — Webhook Fintoc + Tránsito Stellar');

    // a) Simular webhook: payin_completed (fiat recibido en cuenta SpA)
    await Transaction.findByIdAndUpdate(testTransaction._id, {
      $set: {
        status:                      'payin_completed',
        'paymentLegs.0.status':      'completed',
        'paymentLegs.0.completedAt': new Date(),
      },
    });

    logState('Paso 2a', 'payin_completed', 'Webhook Fintoc simulado — fiat confirmado en cuenta SpA');

    // b) Disparar tránsito Stellar (executeWeb3Transit)
    //    Intenta contra Stellar Testnet. Si falla (cuenta sin fondos / sin keys),
    //    aplica un TXID simulado para continuar el flujo de prueba.
    console.log('\n     Intentando tránsito en Stellar Testnet...');

    let stellarTxId = null;
    let stellarUsed = 'testnet';

    try {
      await executeWeb3Transit(testTransaction._id);

      // Leer el txid que el servicio guardó en la BD
      const txAfterStellar = await Transaction.findById(testTransaction._id).lean();
      stellarTxId = txAfterStellar?.stellarTxId ?? null;
      stellarUsed = 'testnet_real';

      console.log(`     ✓  Submit a Stellar Testnet exitoso`);

    } catch (stellarErr) {
      // Cuenta no fondeada o keys no configuradas — simular el resultado
      console.log(`     ⚠  Stellar Testnet no disponible: ${stellarErr.message}`);
      console.log(`     ↳  Aplicando TXID simulado para continuar el flujo...`);

      stellarTxId = SIMULATED_STELLAR_TXID;
      stellarUsed = 'simulado';

      await Transaction.findByIdAndUpdate(testTransaction._id, {
        $set: {
          status:              'in_transit',
          stellarTxId:         SIMULATED_STELLAR_TXID,
          stellarLedger:       50_000_000,
          digitalAsset:        'USDC',
          digitalAssetAmount:  parseFloat((MONTO_CLP / 950).toFixed(7)),
          exchangeRate:        950,
          exchangeRateLockedAt: new Date(),
          stellarSourceAddress: process.env.STELLAR_SPA_PUBLIC_KEY
                                  ?? 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZFOZ4PI7HZ3NAKP2JZNT',
          stellarDestAddress:  testUser.stellarAccount.publicKey,
        },
        $push: {
          providersUsed: 'transit:stellar',
          paymentLegs: {
            stage:       'transit',
            provider:    'stellar',
            status:      'completed',
            externalId:  SIMULATED_STELLAR_TXID,
            completedAt: new Date(),
          },
        },
      });
    }

    logState(
      'Paso 2b',
      'in_transit',
      `TXID [${stellarUsed}]: ${stellarTxId?.substring(0, 16)}...`,
    );

    // Confirmar que la BD refleja el estado in_transit
    const txInTransit = await waitForStatus(testTransaction._id, 'in_transit');
    if (txInTransit?.status !== 'in_transit') {
      throw new Error(`Estado inesperado post-Stellar: ${txInTransit?.status}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PASO 3 — OFF-RAMP BOLIVIA (AV Finance SRL)
    //
    // NOTA DE SIMULACIÓN: En producción, esta etapa corresponde a un flujo
    // distinto (Escenario C: origen no-US, destino BO). Para demostrar el
    // motor de Bolivia E2E, actualizamos la transacción para que refleje
    // el estado que tendría al llegar al Anchor Manual Bolivia.
    // ═══════════════════════════════════════════════════════════════════════
    printSection('PASO 3 — Liquidación Bolivia [SRL / Anchor Manual / BOB]');

    // Preparar la transacción para el corredor Bolivia:
    // Los fondos USDC ya están en Stellar; el Anchor SRL los convierte a BOB.
    const TIPO_CAMBIO_BOB = 6.93; // BOB/USD — tipo de cambio del día (simulado)
    const MONTO_BOB       = parseFloat((txInTransit.digitalAssetAmount * TIPO_CAMBIO_BOB * 1000).toFixed(2));

    await Transaction.findByIdAndUpdate(testTransaction._id, {
      $set: {
        // Actualizar metadatos para el corredor Bolivia (simulación de traspaso SRL)
        legalEntity:         'SRL',
        destinationCountry:  'BO',
        destinationCurrency: 'BOB',
        destinationAmount:   MONTO_BOB,
        'feeBreakdown.alytoFee': Math.round(MONTO_BOB * 0.005 * 100) / 100,
        'feeBreakdown.feeCurrency': 'BOB',
      },
    });

    // Llamar a processBoliviaManualPayout con mock req/res
    const { processBoliviaManualPayout } = await import(
      '../src/controllers/payoutController.js'
    );

    const mockReq = createMockRequest({
      transactionId:   testTransaction._id.toString(),
      tipoCambioManual: TIPO_CAMBIO_BOB,
    });
    const mockRes = createMockResponse();

    await processBoliviaManualPayout(mockReq, mockRes);

    if (mockRes._statusCode !== 200) {
      const errBody = typeof mockRes._body === 'object'
        ? JSON.stringify(mockRes._body)
        : String(mockRes._body);
      throw new Error(`processBoliviaManualPayout falló [${mockRes._statusCode}]: ${errBody}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VALIDACIÓN DE COMPLIANCE — Guardar el PDF en /tmp
    // ═══════════════════════════════════════════════════════════════════════
    const pdfBuffer  = mockRes._body;
    const pdfName    = mockRes._headers['Content-Disposition']
      ?.match(/filename="(.+)"/)?.[1]
      ?? `comprobante_sim_${Date.now()}.pdf`;

    finalPdfPath = path.join('/tmp', pdfName);
    fs.writeFileSync(finalPdfPath, pdfBuffer);

    logState(
      'Paso 3',
      'completed',
      `Liquidado en BOB | PDF: ${pdfName} (${(pdfBuffer.length / 1024).toFixed(1)} KB)`,
    );

    // Confirmar estado final en BD
    const txFinal = await Transaction.findById(testTransaction._id).lean();
    if (txFinal?.status !== 'completed') {
      throw new Error(`Estado final inesperado: ${txFinal?.status}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RESUMEN FINAL
    // ═══════════════════════════════════════════════════════════════════════
    printBanner('RESUMEN DE LA SIMULACIÓN');

    console.log('\n  ESTADOS RECORRIDOS:');
    console.log('  ┌─────┬──────────────────────┬───────────────────────────────────────────┐');
    console.log('  │ Paso│ Estado               │ Detalle                                   │');
    console.log('  ├─────┼──────────────────────┼───────────────────────────────────────────┤');
    stateHistory.forEach(({ step, status, detail }) => {
      const s = step.padEnd(5);
      const st = status.padEnd(20);
      const d = (detail ?? '').substring(0, 41).padEnd(41);
      console.log(`  │ ${s}│ ${st}│ ${d} │`);
    });
    console.log('  └─────┴──────────────────────┴───────────────────────────────────────────┘');

    console.log('\n  ARTEFACTOS GENERADOS:');
    console.log(`  ✓  Comprobante Oficial de Transacción:`);
    console.log(`     ${finalPdfPath}`);
    console.log(`     Tamaño: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

    console.log('\n  DATOS DE LA TRANSACCIÓN:');
    const txResumen = await Transaction.findById(testTransaction._id).lean();
    console.log(`  ─  ID Alyto:       ${txResumen.alytoTransactionId}`);
    console.log(`  ─  Monto Origen:   ${txResumen.originalAmount?.toLocaleString()} ${txResumen.originCurrency}`);
    console.log(`  ─  Activo Digital: ${txResumen.digitalAssetAmount} ${txResumen.digitalAsset}`);
    console.log(`  ─  Stellar TXID:   ${txResumen.stellarTxId}`);
    console.log(`  ─  Entidad Final:  ${txResumen.legalEntity}`);
    console.log(`  ─  Estado Final:   ${txResumen.status}`);

    console.log('\n  RESULTADO FINAL:  ✅  SIMULACIÓN EXITOSA\n');

  } catch (err) {
    console.error(`\n  ✗  Error durante la simulación: ${err.message}`);
    console.error(err.stack);
  } finally {
    // ═══════════════════════════════════════════════════════════════════════
    // TEARDOWN — Limpiar datos de prueba
    // ═══════════════════════════════════════════════════════════════════════
    printSection('TEARDOWN — Limpiando datos de prueba en BD');

    try {
      if (testTransaction?._id) {
        await Transaction.findByIdAndDelete(testTransaction._id);
        console.log(`  ✓  Transacción de prueba eliminada: ${testTransaction._id}`);
      }
      if (testUser?._id) {
        await User.findByIdAndDelete(testUser._id);
        console.log(`  ✓  Usuario de prueba eliminado: ${testUser.email}`);
      }
    } catch (cleanupErr) {
      console.warn(`  ⚠  Error en teardown: ${cleanupErr.message}`);
    }

    await mongoose.connection.close();
    console.log('  ✓  Conexión MongoDB cerrada.');

    if (finalPdfPath) {
      console.log(`\n  📄 El comprobante PDF quedó en: ${finalPdfPath}`);
      console.log(`     Ábrelo con: xdg-open ${finalPdfPath}\n`);
    }
  }
}

// ─── Punto de entrada ────────────────────────────────────────────────────────
runSimulation().catch(err => {
  console.error('[Simulation] Error fatal:', err);
  process.exit(1);
});
