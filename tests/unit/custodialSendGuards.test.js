/**
 * custodialSendGuards.test.js — Guards del envío USDC desde cuenta custodial.
 *
 * Cubre las dos validaciones que corren ANTES de descifrar la llave en KMS o tocar
 * Horizon, y que son las que evitan una pérdida de USDC real:
 *   - dirección destino malformada → el pago se iría a la nada
 *   - memo que excede 28 bytes → Harbor no podría atribuir el depósito
 *
 * Ambas fallan como `isPermanent` porque reintentar no las arregla.
 */

import { sendCustodialUSDC } from '../../src/services/custodyService.js'

// Public key válida (ed25519) para los casos donde el destino no es lo que se prueba.
const VALID_PK = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

describe('sendCustodialUSDC — guard de dirección destino', () => {
  test.each([
    ['vacía',            ''],
    ['null',             null],
    ['no ed25519',       'NOT-A-STELLAR-KEY'],
    ['secret key',       'SA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'],
  ])('rechaza dirección %s como permanente', async (_label, dest) => {
    await expect(sendCustodialUSDC('userid', VALID_PK, dest, 10))
      .rejects.toMatchObject({ isPermanent: true })
  })
})

describe('sendCustodialUSDC — guard de memo', () => {
  test('rechaza memo de más de 28 bytes como permanente', async () => {
    const memo = 'A'.repeat(29)
    await expect(sendCustodialUSDC('userid', VALID_PK, VALID_PK, 10, { memo }))
      .rejects.toMatchObject({ isPermanent: true })
  })

  test('cuenta bytes, no caracteres: multibyte que cabe en 28 chars pero no en 28 bytes', async () => {
    // 15 caracteres de 2 bytes = 30 bytes → debe rechazarse aunque .length sea 15.
    const memo = 'ñ'.repeat(15)
    expect(memo.length).toBeLessThan(28)
    await expect(sendCustodialUSDC('userid', VALID_PK, VALID_PK, 10, { memo }))
      .rejects.toMatchObject({ isPermanent: true })
  })

  test('el guard de dirección corre antes que el de memo', async () => {
    // Ambos inválidos: debe reportar la dirección, que es el fallo más grave.
    await expect(sendCustodialUSDC('userid', VALID_PK, 'bad', 10, { memo: 'A'.repeat(29) }))
      .rejects.toThrow(/destinationPublicKey/)
  })
})
