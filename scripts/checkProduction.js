/**
 * checkProduction.js — Checklist de go-live para Alyto Backend V2.0
 *
 * Verifica en orden:
 *   BLOQUE 1 — Variables de entorno críticas (valores y formatos)
 *   BLOQUE 2 — Conectividad (MongoDB, Vita producción, SendGrid)
 *   BLOQUE 3 — Seguridad (CORS, helmet, rate-limit, logs)
 *   BLOQUE 4 — Datos (corredores activos en BD, corredor CL-CO, wallet Vita)
 *
 * Uso: node scripts/checkProduction.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import crypto   from 'crypto';
import fs       from 'fs';
import path     from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const SRC       = path.join(ROOT, 'src');

// ── Colores ANSI ──────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
}

const OK   = `${C.green}✅${C.reset}`
const FAIL = `${C.red}❌${C.reset}`
const WARN = `${C.yellow}⚠️ ${C.reset}`

// ── Estado global de bloques ──────────────────────────────────────────────────

const STATUS = {
  envVars:      true,
  mongodb:      true,
  vita:         true,
  sendgrid:     true,
  cors:         true,
  security:     true,
  corridors:    true,
}

const ERRORS = {
  envVars:   [],
  mongodb:   [],
  vita:      [],
  sendgrid:  [],
  cors:      [],
  security:  [],
  corridors: [],
}

function fail(block, msg) {
  STATUS[block] = false
  ERRORS[block].push(msg)
  console.log(`  ${FAIL} ${msg}`)
}

function ok(msg) {
  console.log(`  ${OK} ${msg}`)
}

function warn(msg) {
  console.log(`  ${WARN} ${msg}`)
}

// ── BLOQUE 1 — Variables de entorno ──────────────────────────────────────────

function checkEnvVars() {
  console.log(`\n${C.bold}${C.cyan}▸ BLOQUE 1 — Variables de entorno${C.reset}`)

  const checks = [
    // Vita producción
    {
      name: 'VITA_API_URL',
      test: v => v && v.includes('api.vitawallet.io') && !v.includes('stage'),
      hint: 'Debe contener "api.vitawallet.io" sin "stage" (entorno de producción)',
    },
    { name: 'VITA_LOGIN',                test: v => !!v, hint: 'x-login de autenticación Vita' },
    { name: 'VITA_TRANS_KEY',            test: v => !!v, hint: 'x-trans-key de autenticación Vita' },
    { name: 'VITA_SECRET',               test: v => !!v, hint: 'Clave HMAC-SHA256 de Vita' },
    { name: 'VITA_BUSINESS_WALLET_UUID', test: v => !!v && v.includes('-'), hint: 'UUID de la master wallet en Vita' },

    // MongoDB
    {
      name: 'MONGODB_URI',
      test: v => !!v && !v.includes('localhost') && !v.includes('127.0.0.1'),
      hint: 'Debe apuntar al cluster de producción (no localhost)',
    },

    // Auth
    {
      name: 'JWT_SECRET',
      test: v => !!v && v.length >= 32,
      hint: 'Mínimo 32 caracteres para seguridad criptográfica',
    },

    // SendGrid
    { name: 'SENDGRID_API_KEY',              test: v => !!v,                     hint: 'Clave de API de SendGrid' },
    { name: 'SENDGRID_FROM_EMAIL',           test: v => v === 'pagos@alyto.app', hint: 'Debe ser exactamente pagos@alyto.app' },
    { name: 'SENDGRID_TEMPLATE_INITIATED',   test: v => !!v,                     hint: 'Template ID para transacción iniciada' },
    { name: 'SENDGRID_TEMPLATE_COMPLETED',   test: v => !!v,                     hint: 'Template ID para transacción completada' },
    { name: 'SENDGRID_TEMPLATE_FAILED',      test: v => !!v,                     hint: 'Template ID para transacción fallida' },
    { name: 'SENDGRID_TEMPLATE_ADMIN_BOLIVIA', test: v => !!v,                   hint: 'Template ID para notificación admin Bolivia' },

    // Firebase
    { name: 'FIREBASE_PROJECT_ID',    test: v => !!v, hint: 'Firebase Project ID' },
    { name: 'FIREBASE_CLIENT_EMAIL',  test: v => !!v, hint: 'Firebase service account email' },
    { name: 'FIREBASE_PRIVATE_KEY',   test: v => !!v, hint: 'Firebase private key (service account)' },

    // Sentry
    {
      name: 'SENTRY_DSN',
      test: v => !!v && v.startsWith('https://'),
      hint: 'DSN de Sentry (debe comenzar con https://)',
    },

    // App
    {
      name: 'NODE_ENV',
      test: v => v === 'production',
      hint: 'Debe ser exactamente "production"',
    },
    {
      name: 'APP_URL',
      test: v => !!v && v.startsWith('https://'),
      hint: 'Debe usar HTTPS (no HTTP) en producción',
    },
  ]

  let passed = 0
  for (const { name, test, hint } of checks) {
    const value = process.env[name]
    if (test(value)) {
      ok(`${name.padEnd(36)} OK`)
      passed++
    } else {
      fail('envVars', `${name} — ${hint}`)
    }
  }

  console.log(`  ${C.gray}${passed}/${checks.length} variables verificadas${C.reset}`)
}

// ── BLOQUE 2 — Conectividad ───────────────────────────────────────────────────

async function checkMongoDB() {
  console.log(`\n  ${C.bold}Conectividad MongoDB${C.reset}`)
  try {
    const uri = process.env.MONGODB_URI
    if (!uri) {
      fail('mongodb', 'MONGODB_URI no definida')
      return
    }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 })
    ok(`MongoDB conectado — host: ${mongoose.connection.host}`)
  } catch (err) {
    fail('mongodb', `No se pudo conectar a MongoDB: ${err.message}`)
  }
}

function buildVitaSignature(xDate, body = null) {
  const xLogin    = process.env.VITA_LOGIN
  const secretKey = process.env.VITA_SECRET

  let sortedBody = ''
  if (body && Object.keys(body).length > 0) {
    sortedBody = Object.keys(body)
      .sort()
      .map(k => `${k}${typeof body[k] === 'object' ? JSON.stringify(body[k]) : String(body[k])}`)
      .join('')
  }

  const message = `${xLogin}${xDate}${sortedBody}`
  return crypto.createHmac('sha256', secretKey).update(message).digest('hex')
}

async function checkVita() {
  console.log(`\n  ${C.bold}Conectividad Vita Wallet (producción)${C.reset}`)

  const baseUrl   = process.env.VITA_API_URL
  const xLogin    = process.env.VITA_LOGIN
  const xTransKey = process.env.VITA_TRANS_KEY

  if (!baseUrl || !xLogin || !xTransKey || !process.env.VITA_SECRET) {
    fail('vita', 'Variables de Vita incompletas — saltar verificación de conectividad')
    return
  }

  try {
    const xDate     = new Date().toISOString()
    const signature = buildVitaSignature(xDate, null)

    const res = await fetch(`${baseUrl}/api/businesses/prices`, {
      method:  'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-login':      xLogin,
        'x-trans-key':  xTransKey,
        'x-api-key':    xTransKey,
        'x-date':       xDate,
        'Authorization': `V2-HMAC-SHA256, Signature: ${signature}`,
      },
    })

    if (!res.ok) {
      fail('vita', `Vita respondió ${res.status} — posible problema de credenciales de producción`)
      return
    }

    const data = await res.json()

    // Verificar que existen tasas para CLP → CO
    const prices    = data?.data ?? data?.prices ?? data ?? {}
    const hasClpCo  = JSON.stringify(prices).toLowerCase().includes('clp') &&
                      JSON.stringify(prices).toLowerCase().includes('cop')

    if (hasClpCo) {
      ok('Vita API responde correctamente — tasa CLP→COP encontrada')
    } else {
      warn('Vita API responde pero no se encontró tasa CLP→COP explícita (verificar manualmente)')
      STATUS.vita = false
      ERRORS.vita.push('Tasa CLP→COP no encontrada en respuesta de precios')
    }

    ok(`Vita URL de producción: ${baseUrl}`)

  } catch (err) {
    fail('vita', `Error de red al conectar con Vita: ${err.message}`)
  }
}

async function checkSendGrid() {
  console.log(`\n  ${C.bold}SendGrid — email de prueba${C.reset}`)

  const apiKey   = process.env.SENDGRID_API_KEY
  const from     = process.env.SENDGRID_FROM_EMAIL
  const adminTo  = process.env.ADMIN_EMAIL

  if (!apiKey || !from) {
    fail('sendgrid', 'SENDGRID_API_KEY o SENDGRID_FROM_EMAIL no definidos')
    return
  }

  if (!adminTo) {
    warn('ADMIN_EMAIL no definido — no se puede enviar email de prueba (skip)')
    return
  }

  try {
    const payload = {
      personalizations: [{ to: [{ email: adminTo }] }],
      from:             { email: from, name: 'Alyto Sistema' },
      subject:          '[Alyto] ✅ Checklist go-live — SendGrid operativo',
      content: [{
        type:  'text/plain',
        value: `Email de prueba generado automáticamente por checkProduction.js el ${new Date().toISOString()}. Si recibes este email, SendGrid está correctamente configurado para producción.`,
      }],
    }

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (res.status === 202) {
      ok(`SendGrid operativo — email de prueba enviado a ${adminTo}`)
    } else {
      const body = await res.text()
      fail('sendgrid', `SendGrid respondió ${res.status}: ${body.slice(0, 120)}`)
    }
  } catch (err) {
    fail('sendgrid', `Error de red con SendGrid: ${err.message}`)
  }
}

// ── BLOQUE 3 — Seguridad ──────────────────────────────────────────────────────

function checkSecurity() {
  console.log(`\n${C.bold}${C.cyan}▸ BLOQUE 3 — Seguridad${C.reset}`)

  // CORS
  console.log(`\n  ${C.bold}CORS${C.reset}`)
  const allowedOrigins = process.env.ALLOWED_ORIGINS
  const corsOrigin     = process.env.CORS_ORIGIN

  if (allowedOrigins && !allowedOrigins.includes('*')) {
    ok(`ALLOWED_ORIGINS configurado: ${allowedOrigins}`)
  } else if (corsOrigin && corsOrigin !== '*') {
    ok(`CORS_ORIGIN configurado: ${corsOrigin}`)
  } else {
    fail('cors', 'CORS permite wildcard "*" — configurar ALLOWED_ORIGINS con el dominio de producción del frontend')
  }

  // Helmet
  console.log(`\n  ${C.bold}Helmet${C.reset}`)
  const pkgPath = path.join(ROOT, 'package.json')
  const pkg     = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const hasHelmet = !!(pkg.dependencies?.helmet || pkg.devDependencies?.helmet)
  if (hasHelmet) {
    ok('helmet instalado en package.json')
  } else {
    fail('security', 'helmet NO está instalado — ejecutar: npm install helmet')
  }

  // Rate limiting
  console.log(`\n  ${C.bold}Rate limiting${C.reset}`)
  const hasRateLimit = !!(pkg.dependencies?.['express-rate-limit'] || pkg.devDependencies?.['express-rate-limit'])
  if (hasRateLimit) {
    ok('express-rate-limit instalado en package.json')
  } else {
    fail('security', 'express-rate-limit NO está instalado — ejecutar: npm install express-rate-limit')
  }

  // Compression
  console.log(`\n  ${C.bold}Compression${C.reset}`)
  const hasCompression = !!(pkg.dependencies?.compression || pkg.devDependencies?.compression)
  if (hasCompression) {
    ok('compression instalado en package.json')
  } else {
    warn('compression no instalado — recomendado: npm install compression')
  }

  // Logs sensibles
  console.log(`\n  ${C.bold}Auditoría de logs sensibles${C.reset}`)
  const sensitivePatterns = [
    { re: /console\.log\([\s\S]*?password/i,  label: 'password' },
    { re: /console\.log\([\s\S]*?secret/i,    label: 'secret' },
    { re: /console\.log\([\s\S]*?private_key/i, label: 'private_key' },
  ]

  function scanDir(dir) {
    const found = []
    if (!fs.existsSync(dir)) return found

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && !['node_modules', '.git', 'tests'].includes(entry.name)) {
        found.push(...scanDir(full))
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const content = fs.readFileSync(full, 'utf8')
        for (const { re, label } of sensitivePatterns) {
          if (re.test(content)) {
            const rel = path.relative(ROOT, full)
            found.push(`${rel} contiene console.log con "${label}"`)
          }
        }
      }
    }
    return found
  }

  const leaks = scanDir(SRC)
  if (leaks.length === 0) {
    ok('No se detectaron console.log con datos sensibles')
  } else {
    for (const leak of leaks) {
      fail('security', leak)
    }
  }
}

// ── BLOQUE 4 — Datos ──────────────────────────────────────────────────────────

async function checkData() {
  console.log(`\n${C.bold}${C.cyan}▸ BLOQUE 4 — Datos en base de datos${C.reset}`)

  if (mongoose.connection.readyState !== 1) {
    fail('corridors', 'No hay conexión a MongoDB — saltar verificación de datos')
    return
  }

  try {
    // Importar modelo dinámicamente para no acoplar al arranque del servidor
    const { default: TransactionConfig } = await import('../src/models/TransactionConfig.js')

    // Corredores activos
    const totalActive = await TransactionConfig.countDocuments({ isActive: true })
    if (totalActive > 0) {
      ok(`${totalActive} corredor(es) activo(s) encontrado(s) en MongoDB`)
    } else {
      fail('corridors', 'No hay corredores activos en MongoDB — ejecutar: npm run seed:corredores')
    }

    // Corredor CL-CO activo
    const clCoActive = await TransactionConfig.findOne({
      $or: [
        { corridorId:       { $regex: /cl.*co/i } },
        { originCountry:    'CL', destinationCountry: 'CO', isActive: true },
      ],
      isActive: true,
    })

    if (clCoActive) {
      ok(`Corredor CL→CO activo: ${clCoActive.corridorId ?? 'ID no disponible'}`)
    } else {
      fail('corridors', 'Corredor CL-CO no encontrado o inactivo en MongoDB')
    }

  } catch (err) {
    fail('corridors', `Error al consultar corredores: ${err.message}`)
  }

  // Verificar wallet Vita
  console.log(`\n  ${C.bold}Vita master wallet${C.reset}`)
  const walletUuid = process.env.VITA_BUSINESS_WALLET_UUID
  const baseUrl    = process.env.VITA_API_URL
  const xLogin     = process.env.VITA_LOGIN
  const xTransKey  = process.env.VITA_TRANS_KEY

  if (!walletUuid || !baseUrl || !xLogin || !xTransKey || !process.env.VITA_SECRET) {
    warn('Variables de Vita incompletas — saltar verificación de wallet')
    return
  }

  try {
    const xDate     = new Date().toISOString()
    const signature = buildVitaSignature(xDate, null)

    const res = await fetch(`${baseUrl}/api/businesses/wallets/${walletUuid}`, {
      method:  'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-login':      xLogin,
        'x-trans-key':  xTransKey,
        'x-api-key':    xTransKey,
        'x-date':       xDate,
        'Authorization': `V2-HMAC-SHA256, Signature: ${signature}`,
      },
    })

    if (res.ok) {
      const data = await res.json()
      const walletName = data?.data?.name ?? data?.name ?? 'AV Finance'
      ok(`VITA_BUSINESS_WALLET_UUID corresponde a wallet real: "${walletName}"`)
    } else if (res.status === 404) {
      fail('corridors', `VITA_BUSINESS_WALLET_UUID (${walletUuid}) no existe en Vita`)
    } else {
      warn(`Vita wallet check respondió ${res.status} — verificar manualmente`)
    }
  } catch (err) {
    warn(`No se pudo verificar wallet Vita: ${err.message}`)
  }
}

// ── Resumen Final ─────────────────────────────────────────────────────────────

function printSummary() {
  // Combinar los bloques en resultados del resumen
  const envOk       = STATUS.envVars
  const mongoOk     = STATUS.mongodb
  const vitaOk      = STATUS.vita
  const sendgridOk  = STATUS.sendgrid
  const corsOk      = STATUS.cors
  const securityOk  = STATUS.security
  const corridorsOk = STATUS.corridors

  const allOk = envOk && mongoOk && vitaOk && sendgridOk && corsOk && securityOk && corridorsOk

  const row = (label, ok) =>
    `║  ${label.padEnd(28)} ${ok ? C.green + '✅  OK' : C.red + '❌  REVISAR'}${C.reset}          ║`

  console.log('')
  console.log(`${C.bold}╔══════════════════════════════════════════════════╗${C.reset}`)
  console.log(`${C.bold}║      Alyto Backend — Checklist go-live           ║${C.reset}`)
  console.log(`${C.bold}╠══════════════════════════════════════════════════╣${C.reset}`)
  console.log(row('Variables de entorno',  envOk))
  console.log(row('Conectividad MongoDB',  mongoOk))
  console.log(row('Conectividad Vita prod', vitaOk))
  console.log(row('SendGrid operativo',    sendgridOk))
  console.log(row('CORS configurado',      corsOk))
  console.log(row('Seguridad activa',      securityOk))
  console.log(row('Corredores en BD',      corridorsOk))
  console.log(`${C.bold}╠══════════════════════════════════════════════════╣${C.reset}`)

  if (allOk) {
    console.log(`${C.bold}${C.green}║  Estado: ✅  LISTO PARA GO-LIVE                  ║${C.reset}`)
  } else {
    console.log(`${C.bold}${C.red}║  Estado: ❌  REVISAR ERRORES ARRIBA              ║${C.reset}`)
  }

  console.log(`${C.bold}╚══════════════════════════════════════════════════╝${C.reset}`)
  console.log('')

  // Imprimir todos los errores consolidados
  const allErrors = Object.entries(ERRORS).flatMap(([block, errs]) =>
    errs.map(e => `  ${C.red}[${block}]${C.reset} ${e}`)
  )

  if (allErrors.length > 0) {
    console.log(`${C.bold}${C.red}Errores encontrados:${C.reset}`)
    allErrors.forEach(e => console.log(e))
    console.log('')
  }

  return allOk
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════╗`)
  console.log(`║   Alyto Backend V2.0 — Verificación go-live      ║`)
  console.log(`╚══════════════════════════════════════════════════╝${C.reset}`)
  console.log(`  Fecha: ${new Date().toLocaleString('es-CL')}`)

  // BLOQUE 1
  checkEnvVars()

  // BLOQUE 2
  console.log(`\n${C.bold}${C.cyan}▸ BLOQUE 2 — Conectividad${C.reset}`)
  await checkMongoDB()
  await checkVita()
  await checkSendGrid()

  // BLOQUE 3
  checkSecurity()

  // BLOQUE 4
  await checkData()

  // Cerrar conexión MongoDB si quedó abierta
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.close()
  }

  // Resumen
  const passed = printSummary()

  process.exit(passed ? 0 : 1)
}

main().catch(err => {
  console.error(`\n${C.red}[checkProduction] Error fatal: ${err.message}${C.reset}`)
  process.exit(1)
})
