# Skill: trustlines-stellar — Control Regulatorio via Trustlines Stellar

## Propósito
Implementar el congelamiento y descongelamiento de fondos de usuarios usando
Trustlines de Stellar, cumpliendo con las exigencias de control de la ASFI y UIF Bolivia.

## Concepto
En Stellar, una Trustline es la autorización de un usuario para operar un activo específico.
AV Finance SRL como emisor/anchor puede:
- **Autorizar** una trustline: el usuario puede recibir y enviar el activo
- **Revocar** una trustline: los fondos del usuario quedan congelados (freeze)
- **Quemar** un activo: destruir tokens en casos extremos de compliance

## Implementación

### Prerequisito: Asset con AUTH_REQUIRED + AUTH_REVOCABLE
La cuenta SRL debe emitir el asset con flags:
```js
// Al crear el asset en Stellar
const transaction = new TransactionBuilder(sourceAccount)
  .addOperation(Operation.setOptions({
    setFlags: AuthRequiredFlag | AuthRevocableFlag,
  }))
  .build()
```

### Congelar wallet (freeze trustline)
```js
// En stellarService.js
export async function freezeUserTrustline(userStellarPublicKey, assetCode) {
  const sourceKeypair = Keypair.fromSecret(process.env.STELLAR_SRL_SECRET_KEY)
  const sourceAccount = await server.loadAccount(sourceKeypair.publicKey())

  const transaction = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.setTrustLineFlags({
      trustor: userStellarPublicKey,
      asset: new Asset(assetCode, sourceKeypair.publicKey()),
      flags: { authorized: false },  // congela
    }))
    .setTimeout(30)
    .build()

  transaction.sign(sourceKeypair)
  return server.submitTransaction(transaction)
}

export async function unfreezeUserTrustline(userStellarPublicKey, assetCode) {
  // igual pero flags: { authorized: true }
}
```

### Endpoint admin
PATCH /api/v1/admin/wallet/:userId/freeze
Body: { reason: string, reportNumber?: string }
→ 1. Actualiza WalletBOB.status = 'frozen', balanceFrozen = balance, balance = 0
→ 2. Llama freezeUserTrustline() en Stellar
→ 3. Registra WalletTransaction tipo 'freeze' con stellarTxId
→ 4. Notifica al usuario via email (template específico)
→ 5. Registra en ipnLog de todas las transacciones pendientes del usuario

## Reglas de Compliance
- Solo admins con role 'compliance' pueden ejecutar freeze/unfreeze
- Todo freeze debe tener reason obligatorio
- Si existe reportNumber UIF, incluirlo en los metadatos
- El freeze en Stellar es inmediato e irreversible hasta unfreeze explícito
- Registrar en audit log separado para reportes ASFI

## Consideraciones
- En testnet, usar asset USDC del anchor de prueba o crear asset propio AlytoUSD
- En producción, coordinar con ASFI el asset oficial autorizado
- Un usuario frozen no puede iniciar ninguna operación (verificar en middleware)
