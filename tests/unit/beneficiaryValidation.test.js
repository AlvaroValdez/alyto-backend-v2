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
