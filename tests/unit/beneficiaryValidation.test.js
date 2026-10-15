/**
 * beneficiaryValidation.test.js — Ejecutabilidad de los datos del beneficiario.
 *
 * Cierra la causa de raíz "se cobra antes de validar que el payout es ejecutable"
 * en su variante de DATOS (la de SALDO la cubre payoutPreflight). Reproducida e2e
 * el 2026-10-05: pix_key_type "cpf" (el enum real es "code_cpf") pasó el create,
 * generó el QR real del banco y murió en Vita con code 305.
 *
 * Diseño de cero falsos positivos: solo bloquea lo COMPROBADAMENTE inválido —
 * select fuera de enum, campo condicional activo vacío, y el dry-run de
 * buildPayoutInstrument para Harbor. Lo demás pasa.
 */

import '../setup.env.js'
import { validateAgainstVitaFields, checkBeneficiaryExecutable } from '../../src/services/beneficiaryValidation.js'

// Los campos REALES de BR publicados por Vita (forma verificada en prod 2026-10-05).
const CAMPOS_BR = [
  { key: 'beneficiary_first_name', type: 'text' },
  { key: 'beneficiary_last_name',  type: 'text' },
  { key: 'beneficiary_document_type', type: 'select',
    options: [{ value: 'CPF' }, { value: 'CNPJ' }] },
  { key: 'beneficiary_document_number', type: 'text' },
  { key: 'pix_key_type', type: 'select',
    options: [{ value: 'code_cnpj' }, { value: 'email' }, { value: 'code_cpf' },
              { value: 'random_key' }, { value: 'phone_number' }] },
  { key: 'account_bank__code_cpf',     type: 'numeric', when: { key: 'pix_key_type', value: 'code_cpf' } },
  { key: 'account_bank__email',        type: 'email',   when: { key: 'pix_key_type', value: 'email' } },
  { key: 'account_bank__random_key',   type: 'text',    when: { key: 'pix_key_type', value: 'random_key' } },
  { key: 'purpose', type: 'select', options: [{ value: 'EPFAMT' }, { value: 'EPREMT' }] },
  { key: 'purpose_comentary', type: 'text' },
  { key: 'fc_display_cost', type: 'text' },   // interno — nunca se valida
]

const BENEFICIARIO_OK = {
  beneficiary_first_name: 'Ana', beneficiary_last_name: 'Silva',
  beneficiary_document_type: 'CPF', beneficiary_document_number: '39053344705',
  pix_key_type: 'code_cpf', account_bank__code_cpf: '39053344705',
  purpose: 'EPFAMT',
}

describe('validateAgainstVitaFields — enums de los select', () => {
  test('el caso e2e exacto: pix_key_type "cpf" (no existe) se bloquea nombrando los válidos', () => {
    const errores = validateAgainstVitaFields(
      { ...BENEFICIARIO_OK, pix_key_type: 'cpf', account_bank__code_cpf: '39053344705' },
      CAMPOS_BR,
    )
    expect(errores).toHaveLength(1)
    expect(errores[0]).toMatch(/pix_key_type/)
    expect(errores[0]).toMatch(/code_cpf/)   // el mensaje enseña el valor correcto
  })

  test('purpose fuera del enum también se bloquea (el segundo error del payload e2e)', () => {
    const errores = validateAgainstVitaFields({ ...BENEFICIARIO_OK, purpose: 'ISFAMI' }, CAMPOS_BR)
    expect(errores).toHaveLength(1)
    expect(errores[0]).toMatch(/purpose/)
  })

  test('un beneficiario correcto pasa limpio', () => {
    expect(validateAgainstVitaFields(BENEFICIARIO_OK, CAMPOS_BR)).toEqual([])
  })
})

describe('validateAgainstVitaFields — condicionales `when`', () => {
  test('la chave del tipo elegido es obligatoria', () => {
    const { account_bank__code_cpf: _, ...sinChave } = BENEFICIARIO_OK
    const errores = validateAgainstVitaFields(sinChave, CAMPOS_BR)
    expect(errores).toHaveLength(1)
    expect(errores[0]).toMatch(/account_bank__code_cpf/)
  })

  test('las chaves de los OTROS tipos no se exigen (when no coincide)', () => {
    // pix_key_type=code_cpf: email y random_key quedan inactivos y vacíos sin error.
    expect(validateAgainstVitaFields(BENEFICIARIO_OK, CAMPOS_BR)).toEqual([])
  })

  test('when con lista de valores activa el campo para cualquiera de ellos', () => {
    const campos = [
      { key: 'tipo', type: 'select', options: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] },
      { key: 'dato_ab', type: 'text', when: { key: 'tipo', value: ['a', 'b'] } },
    ]
    expect(validateAgainstVitaFields({ tipo: 'a' }, campos)).toHaveLength(1)
    expect(validateAgainstVitaFields({ tipo: 'c' }, campos)).toEqual([])
  })
})

describe('validateAgainstVitaFields — lo que a PROPÓSITO no bloquea', () => {
  test('texto sin `when` vacío NO es error (las rules no traen flag required)', () => {
    // purpose_comentary y hasta los nombres: exigirlos sería adivinar y bloquear
    // ventas legítimas. El proveedor decide; acá solo lo comprobadamente inválido.
    const { purpose_comentary: _, beneficiary_first_name: __, ...minimo } = BENEFICIARIO_OK
    expect(validateAgainstVitaFields(minimo, CAMPOS_BR)).toEqual([])
  })

  test('campos fc_* internos se ignoran aunque traigan cualquier cosa', () => {
    expect(validateAgainstVitaFields({ ...BENEFICIARIO_OK, fc_display_cost: '???' }, CAMPOS_BR)).toEqual([])
  })

  test('sin rules no inventa errores', () => {
    expect(validateAgainstVitaFields(BENEFICIARIO_OK, [])).toEqual([])
    expect(validateAgainstVitaFields(BENEFICIARIO_OK, null)).toEqual([])
  })

  test('un select activo pero VACÍO no se bloquea por enum (presencia no comprobable)', () => {
    const { purpose: _, ...sinPurpose } = BENEFICIARIO_OK
    expect(validateAgainstVitaFields(sinPurpose, CAMPOS_BR)).toEqual([])
  })
})

// ── Formato declarado por Vita (regex_validate / min / max) ──────────────────
//
// Reglas REALES de Venezuela, copiadas de la respuesta de producción del
// 2026-10-14. No son inventadas: son las que Vita publica y las que usó para
// rechazar dos operaciones con el cobro ya emitido.
const CAMPOS_VE = [
  { type: 'text', key: 'beneficiary_document_number', min: 6, max: 10,
    regex_validate: '^\\d+$', regex_message: 'Solo se permiten números' },
  { type: 'text', key: 'account_bank', min: 20, max: 20,
    regex_validate: '^(0102|0156|0172|0114)\\d{16}$',
    regex_message: 'El número de cuenta debe tener 20 dígitos y comenzar con un código de banco válido.' },
]

describe('validateAgainstVitaFields — formato declarado por Vita', () => {
  // Regresión de los dos rechazos reales del 2026-10-14 (bo-ve).
  it('bloquea el documento con letras que Vita rechazó (code 305)', () => {
    const errores = validateAgainstVitaFields(
      { beneficiary_document_number: 'V12345678', account_bank: '01020000000000000001' },
      CAMPOS_VE,
    )
    expect(errores).toHaveLength(1)
    expect(errores[0]).toContain('beneficiary_document_number')
    expect(errores[0]).toContain('Solo se permiten números')
  })

  it('bloquea la cuenta sin código de banco válido que Vita rechazó (code 305)', () => {
    const errores = validateAgainstVitaFields(
      { beneficiary_document_number: '12345678', account_bank: '99990000000000000001' },
      CAMPOS_VE,
    )
    expect(errores).toHaveLength(1)
    expect(errores[0]).toContain('account_bank')
  })

  it('no duplica el punto final del mensaje de Vita', () => {
    const errores = validateAgainstVitaFields({ account_bank: '99990000000000000001' }, CAMPOS_VE)
    expect(errores[0]).not.toMatch(/\.\./)
  })

  it('deja pasar el beneficiario con formato correcto', () => {
    const errores = validateAgainstVitaFields(
      { beneficiary_document_number: '12345678', account_bank: '01020000000000000001' },
      CAMPOS_VE,
    )
    expect(errores).toEqual([])
  })

  it('bloquea por longitud mínima y máxima', () => {
    expect(validateAgainstVitaFields({ beneficiary_document_number: '123' }, CAMPOS_VE)[0]).toContain('demasiado corto')
    expect(validateAgainstVitaFields({ beneficiary_document_number: '12345678901' }, CAMPOS_VE)[0]).toContain('demasiado largo')
  })

  it('NO exige presencia: un campo vacío sin `when` no bloquea', () => {
    expect(validateAgainstVitaFields({}, CAMPOS_VE)).toEqual([])
    expect(validateAgainstVitaFields({ beneficiary_document_number: '   ' }, CAMPOS_VE)).toEqual([])
  })

  it('un regex que no compila en JS se ignora, no rompe ni bloquea', () => {
    const campos = [{ type: 'text', key: 'x', regex_validate: '(?<=mal' }]
    expect(validateAgainstVitaFields({ x: 'cualquier cosa' }, campos)).toEqual([])
  })

  it('descarta un patrón desmedido sin intentar compilarlo', () => {
    const campos = [{ type: 'text', key: 'x', regex_validate: '(a+)+'.repeat(80) }]
    expect(validateAgainstVitaFields({ x: 'a'.repeat(40) }, campos)).toEqual([])
  })

  it('no aplica formato a los select: ese caso ya lo cubre el enum', () => {
    const campos = [{ type: 'select', key: 'tipo', options: [{ value: 'a' }], regex_validate: '^\\d+$' }]
    expect(validateAgainstVitaFields({ tipo: 'a' }, campos)).toEqual([])
  })

  it('ignora los campos internos fc_* aunque traigan regex', () => {
    const campos = [{ type: 'text', key: 'fc_display', regex_validate: '^\\d+$' }]
    expect(validateAgainstVitaFields({ fc_display: 'texto' }, campos)).toEqual([])
  })
})

describe('checkBeneficiaryExecutable — riel Harbor (dry-run del instrumento real)', () => {
  const corridorUS = { payoutMethod: 'owlPay', destinationCountry: 'US', destinationCurrency: 'USD' }

  const US_OK = {
    account_holder_name: 'John Doe', bank_name: 'Bank of America',
    account_number: '123456789012', routing_number: '021000021',
    street: '123 Main St', city: 'Los Angeles', state_province: 'CA', postal_code: '90001',
  }

  test('beneficiario US completo pasa', async () => {
    const r = await checkBeneficiaryExecutable({ corridor: corridorUS, beneficiaryData: US_OK })
    expect(r.ok).toBe(true)
  })

  test('sin routing number se bloquea ANTES de cobrar (el caso "fondos atascados")', async () => {
    const { routing_number: _, ...sinRouting } = US_OK
    const r = await checkBeneficiaryExecutable({ corridor: corridorUS, beneficiaryData: sinRouting })
    expect(r.ok).toBe(false)
    expect(r.errores[0]).toMatch(/routing/i)
  })

  test('routing con formato roto (no son 9 dígitos) se bloquea', async () => {
    const r = await checkBeneficiaryExecutable({
      corridor: corridorUS, beneficiaryData: { ...US_OK, routing_number: '12345' },
    })
    expect(r.ok).toBe(false)
  })
})

describe('checkBeneficiaryExecutable — bordes operativos', () => {
  test('payout manual (anchorBolivia) no valida contra ningún proveedor', async () => {
    const r = await checkBeneficiaryExecutable({
      corridor: { payoutMethod: 'anchorBolivia', destinationCountry: 'BO' },
      beneficiaryData: { cualquier: 'cosa' },
    })
    expect(r.ok).toBe(true)
    expect(r.skipped).toBe('manual_payout')
  })

  test('el kill-switch apaga la validación entera', async () => {
    process.env.BENEFICIARY_VALIDATION_ENABLED = 'false'
    try {
      const r = await checkBeneficiaryExecutable({
        corridor: { payoutMethod: 'owlPay', destinationCountry: 'US', destinationCurrency: 'USD' },
        beneficiaryData: {},   // le falta todo y aun así pasa: el switch manda
      })
      expect(r.ok).toBe(true)
      expect(r.skipped).toBe('disabled')
    } finally {
      delete process.env.BENEFICIARY_VALIDATION_ENABLED
    }
  })
})
