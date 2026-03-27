# Skill: compliance-uif — Monitoreo y Reportes UIF Bolivia

## Propósito
Implementar los controles RegTech exigidos por ASFI/UIF: escaneo de sanciones,
monitoreo heurístico de transacciones anómalas y generación de Reportes de
Operaciones Sospechosas (ROS).

## Escaneo de Sanciones

### Listas a verificar
- OFAC SDN List (EE.UU.): https://ofac.treasury.gov/
- Lista ONU Consolidada: https://scsanctions.un.org/
- PEPs Bolivia (Personas Expuestas Políticamente)

### Implementación básica (Fase 28)
```js
// services/sanctionsService.js
export async function screenUser(user) {
  const name = `${user.firstName} ${user.lastName}`.toLowerCase()
  const docNumber = user.identityDocument?.number

  // Por ahora: verificación básica contra lista local
  // En producción: integrar con API de proveedor especializado
  // (ej. ComplyAdvantage, Refinitiv World-Check, Dow Jones Risk)
  const hits = await SanctionsList.find({
    $or: [
      { name: { $regex: name, $options: 'i' } },
      { documentNumber: docNumber },
    ]
  })

  return {
    isClean: hits.length === 0,
    hits,
    screenedAt: new Date(),
  }
}
```

### Cuándo ejecutar screening
- Al completar KYC (kycStatus → approved)
- Al iniciar cualquier transacción > Bs. 10.000
- Diariamente en batch para todos los usuarios activos

## Monitoreo Heurístico

### Reglas de detección (configurable desde admin)
```js
const RULES = [
  { name: 'high_frequency', description: 'Más de 5 transacciones en 24 horas', check: async (userId) => { ... } },
  { name: 'round_amounts', description: 'Montos redondos repetitivos (ej. 1000, 2000, 3000)', check: async (userId) => { ... } },
  { name: 'structuring', description: 'Múltiples transacciones ligeramente bajo el umbral de reporte', check: async (userId) => { ... } },
  { name: 'high_volume_new_user', description: 'Usuario nuevo con volumen alto en primeros 7 días', check: async (userId) => { ... } },
  { name: 'unusual_corridor', description: 'Corredor inusual para el perfil del usuario', check: async (userId) => { ... } },
]
```

### Modelo Alert (MongoDB)
```js
{
  userId:       ObjectId,
  ruleTriggered: String,
  severity:     'low' | 'medium' | 'high',
  status:       'pending' | 'reviewed' | 'escalated' | 'dismissed',
  reviewedBy:   ObjectId,
  reviewNote:   String,
  rosGenerated: Boolean,
  rosNumber:    String,
  transactionIds: [ObjectId],
  createdAt:    Date,
}
```

## Reporte de Operaciones Sospechosas (ROS)

### Estructura del ROS (exigencia UIF Bolivia)

Datos de AV Finance SRL (emisor del reporte)
Datos del sujeto investigado (KYC completo)
Descripción de la operación sospechosa
Monto total involucrado
Período de la actividad sospechosa
Fundamento de la sospecha (regla activada)
Documentos de respaldo (transacciones, logs)
Fecha y firma del Oficial de Cumplimiento


### Endpoint
POST /api/v1/admin/compliance/ros        — generar ROS en PDF
GET  /api/v1/admin/compliance/alerts     — listar alertas pendientes
PATCH /api/v1/admin/compliance/alerts/:id — revisar/desestimar alerta
GET  /api/v1/admin/compliance/screening/:userId — resultado screening sanciones
