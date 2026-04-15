/**
 * SanctionsList.js — Lista de sanciones OFAC / ONU / UIF Bolivia / PEPs
 *
 * Fase 28 — Compliance AML exigido por ASFI para licencia ETF/PSAV.
 *
 * Implementación básica con lista local en MongoDB.
 * Ruta de actualización: integrar con API de proveedor especializado
 * (ej. ComplyAdvantage, Refinitiv World-Check, Dow Jones Risk).
 */

import mongoose from 'mongoose'

const sanctionsListSchema = new mongoose.Schema({
  entryId: {
    type:    String,
    default: () => `SCN-${Date.now()}`,
    unique:  true,
  },
  type: {
    type:     String,
    enum:     ['individual', 'entity'],
    required: true,
  },
  firstName:    { type: String, default: null },
  lastName:     { type: String, default: null },
  fullName:     { type: String, required: true, index: true },
  aliases:      [String],
  documentNumbers: [String],
  nationality:  { type: String, default: null },
  dateOfBirth:  { type: String, default: null },
  listSource: {
    type:     String,
    enum:     ['OFAC', 'ONU', 'UIF_Bolivia', 'PEP', 'custom'],
    required: true,
  },
  reason:   { type: String, default: null },
  isActive: { type: Boolean, default: true, index: true },
  addedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  notes:    { type: String, default: null },
}, { timestamps: true })

// Índice de texto para búsqueda rápida por nombre y aliases
sanctionsListSchema.index({ fullName: 'text', aliases: 'text' })
sanctionsListSchema.index({ listSource: 1, isActive: 1 })

export default mongoose.model('SanctionsList', sanctionsListSchema)
