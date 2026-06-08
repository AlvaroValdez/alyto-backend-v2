# SendGrid Dynamic Templates — Alyto

Archivos HTML listos para subir como Dynamic Templates en SendGrid.

## Templates pendientes de crear

| Archivo | Env var | Fallback actual | Descripción |
|---------|---------|-----------------|-------------|
| `manual_payin.html` | `SENDGRID_TEMPLATE_MANUAL_PAYIN` | `SENDGRID_TEMPLATE_INITIATED` (genérico) | Usuario recibe instrucciones de transferencia bancaria Bolivia SRL |
| `deposit_confirmed.html` | `SENDGRID_TEMPLATE_DEPOSIT_CONFIRMED` | ninguno (falla silencioso) | Usuario notificado de depósito BOB acreditado |
| `admin_manual_payin.html` | `SENDGRID_TEMPLATE_ADMIN_MANUAL_PAYIN` | `SENDGRID_TEMPLATE_ADMIN_BOLIVIA` | Admin alerta nuevo pago manual (nota: actualmente se usa adminBoliviaAlert — ver nota abajo) |

## Cómo crear en SendGrid

1. Ir a **SendGrid → Email API → Dynamic Templates**
2. Click **Create a Dynamic Template**
3. Nombrar el template (ej. `Alyto — Instrucciones Pago Manual`)
4. Agregar versión → seleccionar **Code Editor**
5. Pegar el contenido del archivo HTML
6. Click **Save** → copiar el **Template ID** (`d-xxxxxxxxxxxxxxxxxxxxxxxx`)
7. Setear la env var correspondiente en Render (staging) y Secrets Manager (VPS prod)

## Variables dinámicas por template

### manual_payin.html
```
{{userName}}           — nombre del usuario
{{transactionId}}      — ID de la transacción ALY-C-...
{{originAmount}}       — monto a transferir (ej. "1,000.00 BOB")
{{destinationAmount}}  — monto que recibirá el beneficiario
{{destinationCurrency}}
{{destinationCountry}}
{{bankName}}           — banco AV Finance SRL (Banco Bisa)
{{accountHolder}}      — "AV Finance SRL"
{{accountNumber}}      — número de cuenta SRL
{{accountType}}        — tipo de cuenta
{{currency}}           — moneda de la cuenta receptora
{{reference}}          — código OBLIGATORIO en el concepto de la transferencia
{{concept}}            — alias de reference
{{instructions}}       — instrucciones adicionales (si aplica)
{{beneficiaryName}}    — nombre del beneficiario final
{{beneficiaryBank}}    — banco del beneficiario
{{beneficiaryAccount}} — cuenta del beneficiario (masked: ****XXXX)
{{createdAt}}          — fecha de la solicitud
{{supportEmail}}
{{supportWhatsapp}}
```

### deposit_confirmed.html
```
{{userName}}      — nombre del usuario
{{amount}}        — monto acreditado (ej. "500.00 BOB")
{{currency}}      — "BOB"
{{newBalance}}    — saldo actualizado (ej. "1,350.00 BOB")
{{wtxId}}         — ID de la WalletTransaction
{{confirmedAt}}   — fecha y hora de acreditación
{{supportEmail}}
```

### admin_manual_payin.html
```
{{transactionId}}      — ID ALY-C-...
{{originAmount}}       — monto de entrada
{{destinationCountry}}
{{userId}}             — MongoDB ObjectId del usuario
{{beneficiaryName}}
{{beneficiaryBank}}
{{beneficiaryAccount}} — masked
{{bankName}}           — banco AV Finance SRL
{{accountNumber}}
{{reference}}          — referencia esperada en el comprobante
{{createdAt}}
{{ledgerUrl}}          — URL directa al ledger admin
```

## Nota sobre ADMIN_MANUAL_PAYIN

El controlador actual (`paymentController.js:1404`) llama a `EMAILS.adminBoliviaAlert(transaction)` para el
correo admin, no a `adminManualPayinAlert`. `adminManualPayinAlert` está definido pero no llamado — es código
preparado para cuando se quiera diferenciar los dos flujos. El fallback actual (`SENDGRID_TEMPLATE_ADMIN_BOLIVIA`)
ya funciona para el flujo Bolivia. Prioridad: `manual_payin.html` y `deposit_confirmed.html` primero.
