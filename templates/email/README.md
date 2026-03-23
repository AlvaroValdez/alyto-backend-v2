# SendGrid Dynamic Templates — Alyto Wallet

Documentación de referencia para crear los templates visuales en el dashboard de SendGrid.
Cada template se configura en **Email API → Dynamic Templates** y su ID se copia a la
variable de entorno correspondiente.

Sintaxis de variables en el editor de SendGrid: `{{variableName}}`

---

## Template: Pago iniciado

**ID env var:** `SENDGRID_TEMPLATE_INITIATED`
**Trigger:** El payin del usuario fue confirmado y el pago está en proceso.
**Destinatario:** Usuario

Variables disponibles:

| Variable | Ejemplo | Descripción |
|---|---|---|
| `{{userName}}` | `"Carlos"` | Nombre del usuario |
| `{{transactionId}}` | `"ALY-20260320-ABC123"` | ID de la transacción Alyto |
| `{{originAmount}}` | `"$100.000 CLP"` | Monto enviado con moneda |
| `{{destinationAmount}}` | `"$404.550 COP"` | Monto a recibir con moneda |
| `{{beneficiaryName}}` | `"María García"` | Nombre completo del beneficiario |
| `{{corridorLabel}}` | `"CLP → COP"` | Corredor del pago |
| `{{estimatedDelivery}}` | `"1 día hábil"` | Tiempo estimado de llegada |
| `{{supportEmail}}` | `"soporte@alyto.io"` | Email de soporte |

**Asunto sugerido:** `Tu pago a {{beneficiaryName}} está en camino, {{userName}}`

---

## Template: Pago completado

**ID env var:** `SENDGRID_TEMPLATE_COMPLETED`
**Trigger:** El payout bancario fue confirmado por Vita Wallet — el dinero llegó al beneficiario.
**Destinatario:** Usuario

Variables disponibles:

| Variable | Ejemplo | Descripción |
|---|---|---|
| `{{userName}}` | `"Carlos"` | Nombre del usuario |
| `{{transactionId}}` | `"ALY-20260320-ABC123"` | ID de la transacción Alyto |
| `{{originAmount}}` | `"$100.000 CLP"` | Monto enviado con moneda |
| `{{destinationAmount}}` | `"$404.550 COP"` | Monto recibido con moneda |
| `{{beneficiaryName}}` | `"María García"` | Nombre completo del beneficiario |
| `{{completedAt}}` | `"20 de marzo de 2026, 14:35 hrs"` | Fecha y hora de completación |
| `{{supportEmail}}` | `"soporte@alyto.io"` | Email de soporte |

**Asunto sugerido:** `¡Listo! {{beneficiaryName}} recibió tu pago`

---

## Template: Pago fallido

**ID env var:** `SENDGRID_TEMPLATE_FAILED`
**Trigger:** El pago fue rechazado (payin denegado o payout fallido).
**Destinatario:** Usuario

Variables disponibles:

| Variable | Ejemplo | Descripción |
|---|---|---|
| `{{userName}}` | `"Carlos"` | Nombre del usuario |
| `{{transactionId}}` | `"ALY-20260320-ABC123"` | ID de la transacción Alyto |
| `{{originAmount}}` | `"$100.000 CLP"` | Monto del pago fallido |
| `{{failedAt}}` | `"20 de marzo de 2026, 14:35 hrs"` | Fecha y hora del fallo |
| `{{supportEmail}}` | `"soporte@alyto.io"` | Email de soporte |
| `{{supportWhatsapp}}` | `"+56988321490"` | WhatsApp de soporte |

**Asunto sugerido:** `Hubo un problema con tu pago — te ayudamos, {{userName}}`

---

## Template: Alerta admin Bolivia

**ID env var:** `SENDGRID_TEMPLATE_ADMIN_BOLIVIA`
**Trigger:** El corredor de pago es `anchorBolivia` — requiere liquidación manual por el equipo operativo.
**Destinatario:** Equipo interno (`SENDGRID_ADMIN_EMAIL`)

Variables disponibles:

| Variable | Ejemplo | Descripción |
|---|---|---|
| `{{transactionId}}` | `"ALY-20260320-ABC123"` | ID de la transacción |
| `{{originAmount}}` | `"$100.000 CLP"` | Monto enviado |
| `{{destinationAmount}}` | `"$700 BOB"` | Monto a entregar en Bolivia |
| `{{beneficiary}}` | objeto completo | Datos del beneficiario (acceder con `{{beneficiary.firstName}}`, etc.) |
| `{{userId}}` | `"663f1a2b..."` | ID MongoDB del usuario remitente |
| `{{createdAt}}` | `"20 de marzo de 2026, 14:35 hrs"` | Fecha de creación |
| `{{ledgerUrl}}` | `"https://admin.alyto.io/admin/ledger/ALY-..."` | Enlace al backoffice |

**Campos de beneficiario accesibles:**
- `{{beneficiary.firstName}}` / `{{beneficiary.lastName}}`
- `{{beneficiary.documentType}}` / `{{beneficiary.documentNumber}}`
- `{{beneficiary.bankCode}}` / `{{beneficiary.accountBank}}` / `{{beneficiary.accountType}}`
- `{{beneficiary.email}}`

**Asunto sugerido:** `[Acción requerida] Payout manual Bolivia — {{transactionId}}`
