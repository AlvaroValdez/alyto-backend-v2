# Skill: wallet-bob — Wallet con Saldo BOB (Dual Ledger Bolivia)

## Propósito
Implementar la wallet con saldo BOB para usuarios SRL Bolivia según los compromisos
ante ASFI. Arquitectura Dual Ledger: saldo off-chain en MongoDB + audit trail on-chain
en Stellar.

## Modelo de Datos

### WalletBOB (MongoDB)
```js
{
  userId:         ObjectId,           // ref: User
  legalEntity:    'SRL',              // solo Bolivia
  currency:       'BOB',
  balance:        Number,             // saldo disponible en BOB
  balanceFrozen:  Number,             // saldo congelado (compliance ASFI)
  balanceReserved: Number,            // saldo reservado en transacciones pendientes
  stellarPublicKey: String,           // wallet Stellar asociada
  trustlineEstablished: Boolean,      // trustline USDC activa en Stellar
  status:         'active' | 'frozen' | 'suspended',
  frozenReason:   String,             // motivo congelamiento UIF/ASFI
  frozenAt:       Date,
  frozenBy:       ObjectId,           // admin que congeló
  createdAt:      Date,
  updatedAt:      Date,
}
```

### WalletTransaction (MongoDB)
```js
{
  walletId:       ObjectId,           // ref: WalletBOB
  userId:         ObjectId,
  type:           'deposit' | 'withdrawal' | 'send' | 'receive' | 'fee' | 'freeze' | 'unfreeze',
  amount:         Number,             // en BOB
  balanceBefore:  Number,
  balanceAfter:   Number,
  status:         'pending' | 'completed' | 'failed' | 'reversed',
  reference:      String,             // transactionId Alyto o referencia bancaria
  stellarTxId:    String,             // TXID Stellar si aplica
  description:    String,
  metadata:       Object,
  createdAt:      Date,
}
```

## Flujos Principales

### Depósito BOB (carga de saldo)
1. Usuario inicia depósito → genera instrucciones bancarias (igual que payin manual)
2. Usuario transfiere BOB a cuenta SRL (QR o transferencia)
3. Admin confirma en Ledger → endpoint POST /api/v1/wallet/deposit/confirm
4. Sistema acredita balance en WalletBOB (off-chain)
5. Sistema registra WalletTransaction tipo 'deposit'
6. Sistema registra en Stellar audit trail (manageData operation)
7. SendGrid notifica al usuario: "Tu saldo fue acreditado"

### Envío P2P (usuario→usuario dentro de Alyto)
1. Usuario selecciona destinatario (por email o @alias)
2. Sistema verifica balance suficiente + status activo
3. Sistema debita WalletBOB origen, acredita WalletBOB destino (operación atómica MongoDB)
4. Sistema registra dos WalletTransactions (send + receive)
5. Stellar audit trail registra la operación
6. Ambos usuarios reciben push notification + email

### Retiro BOB (a cuenta bancaria boliviana)
1. Usuario solicita retiro → especifica monto + datos bancarios destino
2. Sistema reserva el monto (balanceReserved += monto)
3. Admin aprueba en Ledger → SRL transfiere manualmente
4. Admin confirma → sistema libera reserva y debita balance final

## Reglas de Negocio
- Mínimo depósito: Bs. 50
- Máximo saldo: Bs. 50.000 (límite KYC básico)
- Solo usuarios SRL con kycStatus: 'approved'
- Operaciones P2P solo entre usuarios SRL
- balanceFrozen no puede ser operado por el usuario — solo admin/compliance
- Todas las operaciones deben registrar stellarTxId para auditoría ASFI

## Endpoints a Implementar
POST /api/v1/wallet/deposit/initiate    — inicia depósito, retorna instrucciones bancarias
POST /api/v1/wallet/deposit/confirm     — admin confirma depósito recibido
GET  /api/v1/wallet/balance             — saldo actual del usuario
GET  /api/v1/wallet/transactions        — historial de movimientos
POST /api/v1/wallet/send                — envío P2P a otro usuario Alyto
POST /api/v1/wallet/withdraw/request    — solicitud de retiro
PATCH /api/v1/admin/wallet/:userId/freeze   — congelar wallet (compliance)
PATCH /api/v1/admin/wallet/:userId/unfreeze — descongelar wallet
GET  /api/v1/admin/wallet               — listado wallets para admin

## Integración Stellar
- Usar manageData operations para registrar cada movimiento en Stellar testnet
- El TXID de Stellar se guarda en WalletTransaction.stellarTxId
- Usar la cuenta SRL para firmar las transacciones de audit trail
- Ver skill Stellar_Integration_Alyto para reglas de Fee Bump

## Consideraciones ASFI
- Ningún saldo se mueve a Stellar sin verificación fiduciaria previa (transacciones atómicas)
- El congelamiento debe reflejarse tanto en MongoDB (balanceFrozen) como en Stellar (Trustline freeze)
- Todos los movimientos deben tener trazabilidad completa para reportes UIF
