#!/usr/bin/env node
/**
 * sendgrid-clonar-templates.mjs — Copia las Dynamic Templates de una cuenta de
 * SendGrid a otra. SOLO LEE la cuenta de origen; nunca la modifica.
 *
 *   node scripts/sendgrid-clonar-templates.mjs                  # simulacro, no escribe nada
 *   node scripts/sendgrid-clonar-templates.mjs --apply          # crea en el destino
 *   node scripts/sendgrid-clonar-templates.mjs --apply --todas  # incluye las no referenciadas
 *
 * Variables:
 *   SENDGRID_API_KEY          clave de la cuenta ORIGEN (la de producción)
 *   SENDGRID_DEST_API_KEY     clave de la cuenta DESTINO (la nueva, de staging)
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * El plan de SendGrid tiene tope duro de 100 correos por día **por cuenta**, no
 * por API key, y el plan gratuito no admite subusers (`/v3/subusers` → 403). El
 * 2026-10-01 se midió que 51 de los 112 mensajes del día salían de entornos de
 * prueba, así que más de la mitad del cupo de producción se gastaba en correos
 * que nadie iba a leer, y al agotarse el cupo los envíos reales fallaban.
 *
 * La separación real es darle a staging su propia cuenta de SendGrid. Pero las
 * Dynamic Templates viven **dentro de cada cuenta**: la cuenta nueva nace vacía y
 * los `SENDGRID_TEMPLATE_*` del código apuntarían a plantillas inexistentes, así
 * que todo envío con plantilla fallaría. Este script cierra ese hueco.
 *
 * Copia, por cada plantilla, su versión activa: nombre, asunto, HTML y texto
 * plano. Al terminar imprime el bloque de variables listo para pegar en el
 * entorno de staging, que es la parte donde un `d-...` mal copiado a mano pasa
 * desapercibido hasta que un usuario no recibe su correo.
 */
import * as dotenv from 'dotenv'
dotenv.config()

const APPLY = process.argv.includes('--apply')
const TODAS = process.argv.includes('--todas')

const ORIGEN  = process.env.SENDGRID_API_KEY
const DESTINO = process.env.SENDGRID_DEST_API_KEY

if (!ORIGEN) {
  console.error('Falta SENDGRID_API_KEY (cuenta de origen).')
  process.exit(1)
}
if (APPLY && !DESTINO) {
  console.error('Falta SENDGRID_DEST_API_KEY (cuenta destino). Sin ella solo se puede simular.')
  process.exit(1)
}

const api = async (key, path, init = {}) => {
  const res = await fetch(`https://api.sendgrid.com${path}`, {
    ...init,
    headers: {
      Authorization:  `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const texto = await res.text()
  let cuerpo = null
  try { cuerpo = texto ? JSON.parse(texto) : null } catch { cuerpo = texto }
  if (!res.ok) {
    const detalle = cuerpo?.errors?.map(e => e.message).join('; ') ?? String(cuerpo).slice(0, 200)
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${detalle}`)
  }
  return cuerpo
}

/** Qué plantillas usa el código, según las variables de entorno presentes. */
function referenciadas() {
  const mapa = new Map()   // id → nombre de la variable (sin el prefijo)
  for (const [clave, valor] of Object.entries(process.env)) {
    if (clave.startsWith('SENDGRID_TEMPLATE_') && valor) {
      mapa.set(valor, clave)
    }
  }
  return mapa
}

const usadas = referenciadas()
console.log(`\nModo: ${APPLY ? 'APLICAR (escribe en el destino)' : 'SIMULACRO (no escribe nada)'}`)
console.log(`Plantillas referenciadas por el entorno actual: ${usadas.size}\n`)

const lista = await api(ORIGEN, '/v3/templates?generations=dynamic&page_size=200')
const plantillas = lista.result ?? []

const aCopiar = TODAS ? plantillas : plantillas.filter(t => usadas.has(t.id))
console.log(`Encontradas en origen: ${plantillas.length} | a copiar: ${aCopiar.length}`)
if (!TODAS && plantillas.length !== aCopiar.length) {
  console.log(`(se omiten ${plantillas.length - aCopiar.length} que ninguna variable referencia; usar --todas para incluirlas)`)
}
console.log('')

const equivalencias = []   // { variable, idViejo, idNuevo, nombre }
const fallos = []

for (const t of aCopiar) {
  const variable = usadas.get(t.id) ?? `(sin variable) ${t.name}`
  const activa = (t.versions ?? []).find(v => v.active === 1) ?? (t.versions ?? [])[0]

  if (!activa) {
    fallos.push({ variable, motivo: 'no tiene ninguna versión' })
    console.log(`  ✗ ${variable.padEnd(42)} sin versiones — se omite`)
    continue
  }

  if (!APPLY) {
    console.log(`  · ${variable.padEnd(42)} ${t.id} → (se crearía)`)
    equivalencias.push({ variable, idViejo: t.id, idNuevo: '<pendiente>', nombre: t.name })
    continue
  }

  try {
    // El listado no trae el contenido: hay que pedir la versión completa.
    const detalle = await api(ORIGEN, `/v3/templates/${t.id}/versions/${activa.id}`)

    const creada = await api(DESTINO, '/v3/templates', {
      method: 'POST',
      body:   JSON.stringify({ name: t.name, generation: 'dynamic' }),
    })

    await api(DESTINO, `/v3/templates/${creada.id}/versions`, {
      method: 'POST',
      body:   JSON.stringify({
        name:           activa.name ?? 'v1',
        subject:        detalle.subject ?? '',
        html_content:   detalle.html_content ?? '',
        plain_content:  detalle.plain_content ?? '',
        active:         1,
        // El editor con el que se creó: conservarlo evita que SendGrid
        // reinterprete el HTML al abrirlo en el panel.
        editor:         detalle.editor ?? 'code',
      }),
    })

    equivalencias.push({ variable, idViejo: t.id, idNuevo: creada.id, nombre: t.name })
    console.log(`  ✓ ${variable.padEnd(42)} ${t.id} → ${creada.id}`)
  } catch (err) {
    fallos.push({ variable, motivo: err.message })
    console.log(`  ✗ ${variable.padEnd(42)} ${err.message}`)
  }
}

console.log('\n' + '─'.repeat(78))
console.log(`Copiadas: ${equivalencias.filter(e => e.idNuevo !== '<pendiente>').length} | fallidas: ${fallos.length}`)

if (equivalencias.length) {
  console.log('\n── Variables para el entorno de STAGING ──')
  console.log('(pegar en Render; los ids son los de la cuenta nueva)\n')
  for (const e of equivalencias) {
    if (e.variable.startsWith('SENDGRID_TEMPLATE_')) {
      console.log(`${e.variable}=${e.idNuevo}`)
    }
  }
  console.log('\nRecordá además apuntar SENDGRID_API_KEY de staging a la clave de la cuenta nueva,')
  console.log('y verificar el remitente (SENDGRID_FROM_EMAIL) en esa cuenta, o los envíos se rechazan.')
}

if (fallos.length) {
  console.log('\n── Fallidas ──')
  fallos.forEach(f => console.log(`  ${f.variable}: ${f.motivo}`))
  process.exitCode = 1
}

if (!APPLY) {
  console.log('\nSimulacro: no se escribió nada. Repetir con --apply y SENDGRID_DEST_API_KEY para crearlas.')
}
