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
  /**
   * Tokens normalizados del nombre y de TODOS los alias, en un solo array.
   *
   * Es el campo contra el que se criba. Existe porque buscar por $regex sobre
   * `fullName` recorría la coleccion entera y, peor, casaba por subcadena: con
   * las ~20.500 entradas reales de OFAC y ONU eso bloquea a usuarios legitimos
   * cuyo nombre aparece DENTRO de otra palabra. Indexado multikey, la consulta
   * por $all usa indice y es exacta por palabra.
   */
  nameTokens:   { type: [String], default: [], index: true },
  /**
   * Nombre principal y cada alias, POR SEPARADO. `nameTokens` sirve de prefiltro
   * indexado; la confirmacion se hace contra estas variantes una a una, porque
   * mezclarlas produce coincidencias cruzadas (un token del alias con otro del
   * nombre principal) que senalan a gente que no esta en la lista.
   */
  nameVariants: { type: [String], default: [] },
  /** Documentos normalizados (sin guiones ni puntos) para comparar de verdad. */
  documentsNormalized: { type: [String], default: [], index: true },
  /** Identificador estable en la lista de origen. Permite recargar sin duplicar. */
  sourceId:     { type: String, default: null, index: true },
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
}, { timestamps: true, collection: 'sanctionslists' })

// Índice de texto para búsqueda rápida por nombre y aliases
sanctionsListSchema.index({ fullName: 'text', aliases: 'text' })
sanctionsListSchema.index({ listSource: 1, isActive: 1 })
// El que de verdad sirve al cribado: multikey sobre tokens, filtrando activos.
sanctionsListSchema.index({ isActive: 1, nameTokens: 1 })
// Recarga idempotente: una entrada por (fuente, id de origen).
sanctionsListSchema.index({ listSource: 1, sourceId: 1 }, { unique: true, sparse: true })

export default mongoose.model('SanctionsList', sanctionsListSchema)
