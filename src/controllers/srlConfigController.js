/**
 * srlConfigController.js — Gestión de configuración SRL Bolivia (admin)
 *
 * Permite al admin subir, activar/desactivar y eliminar los códigos QR
 * que se muestran al usuario en las instrucciones de pago manual Bolivia.
 *
 * Endpoints (montados bajo /api/v1/admin/srl-config en adminRoutes.js):
 *   GET    /                 — Ver config completa (todos los QR, activos e inactivos)
 *   POST   /qr               — Subir nuevo QR (multipart: label + file)
 *   PATCH  /qr/:qrId         — Activar / desactivar un QR
 *   DELETE /qr/:qrId         — Eliminar un QR permanentemente
 *   PATCH  /bank-data        — Actualizar datos bancarios de AV Finance SRL
 */

import SRLConfig from '../models/SRLConfig.js';
import Sentry    from '../services/sentry.js';

// ─── GET /api/v1/admin/srl-config ─────────────────────────────────────────────

/**
 * Devuelve la configuración SRL completa con todos los QR (activos e inactivos).
 * La vista de detalle admin muestra todos; el frontend de usuario solo recibe los activos.
 */
export async function getSRLConfig(req, res) {
  try {
    const doc = await SRLConfig.findOneAndUpdate(
      { key: 'srl_bolivia' },
      { $setOnInsert: { key: 'srl_bolivia' } },
      { upsert: true, new: true },
    ).populate('qrImages.uploadedBy', 'firstName lastName email').lean();

    return res.status(200).json({
      qrImages:  doc.qrImages ?? [],
      bankData:  doc.bankData  ?? {},
      updatedAt: doc.updatedAt,
      total:    (doc.qrImages ?? []).length,
      active:   (doc.qrImages ?? []).filter(q => q.isActive).length,
    });

  } catch (err) {
    console.error('[SRLConfig] Error en getSRLConfig:', err.message);
    Sentry.captureException(err, { tags: { controller: 'srlConfigController' } });
    return res.status(500).json({ error: 'Error al obtener la configuración SRL.' });
  }
}

// ─── POST /api/v1/admin/srl-config/qr ────────────────────────────────────────

/**
 * Sube un nuevo código QR de pago.
 *
 * Content-Type: multipart/form-data
 * Campos:
 *   label  {string}  — Nombre del método de pago (ej. "Tigo Money", "Banco Bisa QR")
 *   qr     {File}    — Imagen PNG/JPG del QR (máx. 2 MB)
 *
 * El QR se almacena como base64 en MongoDB y se devuelve en las instrucciones
 * de pago de todos los corredores SRL con payinMethod === 'manual'.
 */
export async function uploadSRLQR(req, res) {
  try {
    const { label } = req.body;
    const file      = req.file;

    if (!label?.trim()) {
      return res.status(400).json({
        error:   'Campo label requerido.',
        message: 'Indica el nombre del método de pago (ej. "Tigo Money", "Banco Bisa QR").',
      });
    }

    if (!file) {
      return res.status(400).json({
        error:   'Imagen QR requerida.',
        message: 'Sube un archivo PNG o JPG del código QR.',
      });
    }

    const imageBase64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;

    const doc = await SRLConfig.findOneAndUpdate(
      { key: 'srl_bolivia' },
      {
        $setOnInsert: { key: 'srl_bolivia' },
        $push: {
          qrImages: {
            label:       label.trim(),
            imageBase64,
            isActive:    true,
            uploadedAt:  new Date(),
            uploadedBy:  req.user._id,
          },
        },
      },
      { upsert: true, new: true },
    ).lean();

    const added = doc.qrImages[doc.qrImages.length - 1];

    console.info('[SRLConfig] QR subido por admin.', {
      label:     added.label,
      qrId:      added.qrId,
      adminId:   req.user._id,
      sizeBytes: file.size,
    });

    return res.status(201).json({
      qrId:      added.qrId,
      label:     added.label,
      isActive:  added.isActive,
      uploadedAt: added.uploadedAt,
      message:   `QR "${added.label}" subido correctamente. Se mostrará en las instrucciones de pago Bolivia.`,
    });

  } catch (err) {
    console.error('[SRLConfig] Error en uploadSRLQR:', err.message);
    Sentry.captureException(err, { tags: { controller: 'srlConfigController', action: 'uploadSRLQR' } });
    return res.status(500).json({ error: 'Error al subir el código QR.' });
  }
}

// ─── PATCH /api/v1/admin/srl-config/qr/:qrId ─────────────────────────────────

/**
 * Activa o desactiva un QR existente.
 *
 * Body: { isActive: boolean }
 *
 * Un QR desactivado no se muestra al usuario en las instrucciones de pago
 * pero no se elimina del sistema (permite reactivarlo sin re-subir la imagen).
 */
export async function toggleSRLQR(req, res) {
  try {
    const { qrId }    = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        error:   'Campo isActive requerido.',
        message: 'Envía { "isActive": true } o { "isActive": false }.',
      });
    }

    const result = await SRLConfig.findOneAndUpdate(
      { key: 'srl_bolivia', 'qrImages.qrId': qrId },
      { $set: { 'qrImages.$.isActive': isActive } },
      { new: true },
    ).lean();

    if (!result) {
      return res.status(404).json({ error: `QR "${qrId}" no encontrado.` });
    }

    const updated = result.qrImages.find(q => q.qrId === qrId);

    console.info('[SRLConfig] QR toggled.', {
      qrId,
      label:    updated?.label,
      isActive,
      adminId:  req.user._id,
    });

    return res.status(200).json({
      qrId,
      label:    updated?.label,
      isActive,
      message:  `QR "${updated?.label}" ${isActive ? 'activado' : 'desactivado'}.`,
    });

  } catch (err) {
    console.error('[SRLConfig] Error en toggleSRLQR:', err.message);
    Sentry.captureException(err, { tags: { controller: 'srlConfigController', action: 'toggleSRLQR' } });
    return res.status(500).json({ error: 'Error al actualizar el QR.' });
  }
}

// ─── DELETE /api/v1/admin/srl-config/qr/:qrId ────────────────────────────────

/**
 * Elimina permanentemente un QR de la configuración.
 * No afecta las transacciones ya creadas (su paymentQR está en la transacción).
 */
export async function deleteSRLQR(req, res) {
  try {
    const { qrId } = req.params;

    const result = await SRLConfig.findOneAndUpdate(
      { key: 'srl_bolivia' },
      { $pull: { qrImages: { qrId } } },
      { new: true },
    ).lean();

    if (!result) {
      return res.status(404).json({ error: `QR "${qrId}" no encontrado.` });
    }

    console.info('[SRLConfig] QR eliminado.', { qrId, adminId: req.user._id });

    return res.status(200).json({
      qrId,
      message: `QR eliminado correctamente.`,
    });

  } catch (err) {
    console.error('[SRLConfig] Error en deleteSRLQR:', err.message);
    Sentry.captureException(err, { tags: { controller: 'srlConfigController', action: 'deleteSRLQR' } });
    return res.status(500).json({ error: 'Error al eliminar el QR.' });
  }
}

// ─── PATCH /api/v1/admin/srl-config/bank-data ────────────────────────────────

/**
 * Actualiza los datos bancarios de AV Finance SRL.
 * Estos datos se muestran al usuario en las instrucciones de pago manual Bolivia.
 *
 * Body: { bankName, accountHolder, accountNumber, accountType }
 */
export async function updateBankData(req, res) {
  try {
    const { bankName, accountHolder, accountNumber, accountType } = req.body;

    if (!bankName?.trim() || !accountHolder?.trim() || !accountNumber?.trim() || !accountType?.trim()) {
      return res.status(400).json({ error: 'Todos los campos bancarios son requeridos.' });
    }

    const doc = await SRLConfig.findOneAndUpdate(
      { key: 'srl_bolivia' },
      {
        $setOnInsert: { key: 'srl_bolivia' },
        $set: {
          'bankData.bankName':      bankName.trim(),
          'bankData.accountHolder': accountHolder.trim(),
          'bankData.accountNumber': accountNumber.trim(),
          'bankData.accountType':   accountType.trim(),
        },
      },
      { upsert: true, new: true },
    ).lean();

    console.info('[SRLConfig] Datos bancarios actualizados.', { adminId: req.user._id });

    return res.status(200).json({
      bankData: doc.bankData,
      message:  'Datos bancarios actualizados correctamente.',
    });

  } catch (err) {
    console.error('[SRLConfig] Error en updateBankData:', err.message);
    Sentry.captureException(err, { tags: { controller: 'srlConfigController', action: 'updateBankData' } });
    return res.status(500).json({ error: 'Error al actualizar los datos bancarios.' });
  }
}
