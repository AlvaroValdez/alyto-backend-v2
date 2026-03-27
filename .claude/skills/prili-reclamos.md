# Skill: prili-reclamos — Punto de Reclamo PRILI (ASFI Bolivia)

## Propósito
Implementar el sistema de gestión de reclamos de primera instancia (PRILI) exigido
por ASFI para la licencia ETF/PSAV de AV Finance SRL.

## Concepto PRILI
PRILI = Punto de Reclamo de Primera Instancia. Exigencia ASFI para cualquier
entidad financiera regulada en Bolivia. El usuario debe poder presentar un reclamo
desde la app y recibir respuesta en el plazo regulatorio.

## Plazos regulatorios ASFI
- Acuse de recibo: inmediato (automático)
- Respuesta de primera instancia: 10 días hábiles
- Si no resuelto: escala a ASFI (segunda instancia)

## Modelo Reclamo (MongoDB)
```js
{
  reclamoId:      String,           // formato: REC-SRL-TIMESTAMP-NANOID
  userId:         ObjectId,
  transactionId:  ObjectId,         // opcional, si es sobre una transacción
  tipo:           'cobro_indebido' | 'transferencia_no_recibida' | 'demora' |
                  'error_monto' | 'cuenta_bloqueada' | 'otro',
  descripcion:    String,           // máx 500 chars
  montoReclamado: Number,           // BOB
  documentos:     [{ filename, base64, mimetype, uploadedAt }],
  status:         'recibido' | 'en_revision' | 'resuelto' | 'escalado_asfi' | 'cerrado',
  respuesta:      String,           // respuesta de AV Finance al usuario
  respondidoPor:  ObjectId,
  respondidoAt:   Date,
  escaladoAt:     Date,
  cerradoAt:      Date,
  satisfecho:     Boolean,          // ¿el usuario quedó satisfecho?
  createdAt:      Date,
  plazoVence:     Date,             // createdAt + 10 días hábiles
}
```

## Endpoints
POST /api/v1/reclamos                    — usuario presenta reclamo
GET  /api/v1/reclamos                    — usuario lista sus reclamos
GET  /api/v1/reclamos/:reclamoId         — detalle de un reclamo
POST /api/v1/reclamos/:reclamoId/docs    — subir documentos adicionales
GET  /api/v1/admin/reclamos              — admin lista todos los reclamos
GET  /api/v1/admin/reclamos/:reclamoId   — admin ve detalle completo
PATCH /api/v1/admin/reclamos/:reclamoId  — admin responde/cierra reclamo
GET  /api/v1/admin/reclamos/vencimientos — reclamos próximos a vencer plazo ASFI

## UI en el Frontend (usuarios SRL)
Sección "Mis Reclamos" en el dashboard:
- Botón "Presentar Reclamo" → formulario con tipo + descripción + adjuntos opcionales
- Lista de reclamos con status y plazo de respuesta
- Badge de alerta si el plazo está por vencer

## UI en el Admin (Ledger)
- Panel "Reclamos PRILI" con filtros por status y fecha
- Indicador visual de reclamos próximos a vencer (rojo si < 2 días hábiles)
- Formulario de respuesta con plantillas predefinidas
- Exportación a PDF para reportes ASFI

## Emails automáticos
- Al recibir reclamo: confirmación al usuario con número de reclamo y plazo
- A los 7 días sin respuesta: alerta interna al admin
- Al responder: notificación al usuario con la respuesta
- Al escalar a ASFI: notificación al usuario y al Oficial de Cumplimiento
