/**
 * sanctionsController.js — Admin: gestión de lista de sanciones AML
 *
 * Fase 28 — ASFI Bolivia.
 *
 * Endpoints:
 *   GET    /api/v1/admin/sanctions               — listar entradas
 *   POST   /api/v1/admin/sanctions               — agregar entrada
 *   DELETE /api/v1/admin/sanctions/:entryId      — desactivar (baja lógica)
 *   POST   /api/v1/admin/sanctions/screen        — verificación manual
 */

import * as Sentry   from '@sentry/node'
import SanctionsList from '../models/SanctionsList.js'
import { screenUser } from '../services/sanctionsService.js'

// ─── GET /api/v1/admin/sanctions ──────────────────────────────────────────────

export async function listSanctions(req, res) {
  try {
    const { listSource, type, search, active, page = 1, limit = 20 } = req.query

    const filter = {}
    if (listSource)        filter.listSource = listSource
    if (type)              filter.type       = type
    if (active !== undefined) filter.isActive = active !== 'false'
    if (search) {
      filter.$or = [
        { fullName:       { $regex: search, $options: 'i' } },
        { aliases:        { $elemMatch: { $regex: search, $options: 'i' } } },
        { documentNumbers: search },
      ]
    }

    const pageNum  = Math.max(1, Number(page))
    const limitNum = Math.min(100, Math.max(1, Number(limit)))
    const skip     = (pageNum - 1) * limitNum

    const [entries, total] = await Promise.all([
      SanctionsList.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('addedBy', 'firstName lastName')
        .lean(),
      SanctionsList.countDocuments(filter),
    ])

    return res.json({
      entries,
      pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'sanctionsController', fn: 'listSanctions' } })
    console.error('[Sanctions] Error en listSanctions:', err.message)
    return res.status(500).json({ error: 'Error al listar sanciones.' })
  }
}

// ─── POST /api/v1/admin/sanctions ─────────────────────────────────────────────

export async function addSanction(req, res) {
  try {
    const {
      type, firstName, lastName, fullName, aliases, documentNumbers,
      nationality, dateOfBirth, listSource, reason, notes,
    } = req.body

    if (!fullName?.trim()) {
      return res.status(400).json({ error: 'fullName es requerido.' })
    }
    if (!listSource) {
      return res.status(400).json({ error: 'listSource es requerido.' })
    }

    const entry = await SanctionsList.create({
      type:            type ?? 'individual',
      firstName:       firstName?.trim() ?? null,
      lastName:        lastName?.trim()  ?? null,
      fullName:        fullName.trim(),
      aliases:         Array.isArray(aliases)         ? aliases         : (aliases         ? [aliases]         : []),
      documentNumbers: Array.isArray(documentNumbers) ? documentNumbers : (documentNumbers ? [documentNumbers] : []),
      nationality:     nationality ?? null,
      dateOfBirth:     dateOfBirth ?? null,
      listSource,
      reason:          reason?.trim() ?? null,
      notes:           notes?.trim()  ?? null,
      addedBy:         req.user._id,
    })

    console.info('[Sanctions] ✅ Entrada agregada:', { entryId: entry.entryId, fullName: entry.fullName, listSource })
    return res.status(201).json({ entryId: entry.entryId, fullName: entry.fullName, listSource })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'sanctionsController', fn: 'addSanction' } })
    console.error('[Sanctions] Error en addSanction:', err.message)
    return res.status(500).json({ error: 'Error al agregar entrada.' })
  }
}

// ─── DELETE /api/v1/admin/sanctions/:entryId ──────────────────────────────────

export async function removeSanction(req, res) {
  try {
    const { entryId } = req.params

    const entry = await SanctionsList.findOneAndUpdate(
      { entryId },
      { isActive: false },
      { returnDocument: 'after' },
    )
    if (!entry) {
      return res.status(404).json({ error: 'Entrada no encontrada.' })
    }

    console.info('[Sanctions] Entrada desactivada:', { entryId, fullName: entry.fullName })
    return res.json({ entryId, isActive: false, message: 'Entrada desactivada.' })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'sanctionsController', fn: 'removeSanction' } })
    console.error('[Sanctions] Error en removeSanction:', err.message)
    return res.status(500).json({ error: 'Error al desactivar entrada.' })
  }
}

// ─── POST /api/v1/admin/sanctions/screen ─────────────────────────────────────

export async function screenUserManual(req, res) {
  try {
    const { firstName, lastName, documentNumber } = req.body

    if (!firstName?.trim() && !lastName?.trim() && !documentNumber?.trim()) {
      return res.status(400).json({
        error: 'Proporciona al menos firstName, lastName o documentNumber.',
      })
    }

    const result = await screenUser({ firstName, lastName, documentNumber })
    return res.json(result)

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'sanctionsController', fn: 'screenUserManual' } })
    console.error('[Sanctions] Error en screenUserManual:', err.message)
    return res.status(500).json({ error: 'Error en el screening.' })
  }
}
