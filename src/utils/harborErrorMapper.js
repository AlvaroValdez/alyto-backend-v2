/**
 * harborErrorMapper.js — Centraliza la traducción de errores Harbor/OwlPay
 * a mensajes accionables (técnico para admin, claro para usuario final).
 *
 * Toda nueva categoría de error encontrada en tests/producción se agrega
 * aquí — UN solo lugar para mantener.
 *
 * Códigos Harbor (per harbor_api_documentation.pdf §10):
 *   2005 - Validation error (schema)
 *   3004 - Failed to create withdrawal order (banking partner rejection)
 *   3018 - Failed to get withdrawal quotes (corridor not enabled)
 *   422  - Validation error (top-level)
 *   401  - Unauthorized
 *   409  - Duplicate transfer
 *   400  - Bad request
 */

/**
 * @typedef {object} MappedError
 * @property {string} category       - Etiqueta interna (INVALID_POSTAL_CODE, etc.)
 * @property {string} adminMessage   - Detalle técnico para admin/logs/Sentry
 * @property {string} userMessage    - Mensaje claro para el beneficiario/usuario final
 * @property {string} userAction     - Qué debe hacer el usuario para resolver
 * @property {boolean} retryable     - Si el usuario puede simplemente reintentar
 */

/**
 * @param {Error & { code?, status?, data?, details?, isTransient? }} err
 * @returns {MappedError}
 */
export function mapHarborError(err) {
  const code     = err.code ?? err.data?.code ?? null;
  const status   = err.status ?? err.data?.status ?? null;
  const details  = err.details ?? err.data?.details ?? [];
  const message  = err.data?.message ?? err.message ?? 'Error desconocido';
  const detailsStr = Array.isArray(details) ? details.join(' ') : String(details ?? '');

  // ─── 3004 — Banking partner rejection (post-schema validation) ───────────
  if (code === 3004) {
    // Postal code format por país
    const pcMatch = detailsStr.match(/postal code.*country (\w+).*format[:\s]*(.+?)(?:\.|$)/i);
    if (pcMatch) {
      return {
        category:     'INVALID_POSTAL_CODE',
        adminMessage: `Postal code inválido para ${pcMatch[1]}: ${detailsStr}`,
        userMessage:  `El código postal del beneficiario no es válido para ${pcMatch[1]}. Formato esperado: ${pcMatch[2].trim()}.`,
        userAction:   'Verifica el código postal con el beneficiario o su banco.',
        retryable:    true,
      };
    }

    // CPF brasileño inválido
    if (/valid Brazilian CPF|valid CNPJ or CPF/i.test(detailsStr)) {
      return {
        category:     'INVALID_CPF',
        adminMessage: `CPF inválido (falla validación mod-11): ${detailsStr}`,
        userMessage:  'El CPF brasileño ingresado no es válido. Debe ser un CPF real con dígitos verificadores correctos (11 dígitos).',
        userAction:   'Solicita al beneficiario su CPF correcto.',
        retryable:    true,
      };
    }

    // SEPA bug Harbor (workaround: usar WIRE)
    if (/SWIFT_CODE.*not found/i.test(detailsStr)) {
      return {
        category:     'HARBOR_BUG_SEPA',
        adminMessage: 'Bug conocido Harbor sandbox: SEPA requiere SWIFT_CODE internamente pero su schema lo rechaza. Workaround: usar WIRE.',
        userMessage:  'Hay un problema temporal con el método SEPA. Por favor selecciona Transferencia Internacional (WIRE) para continuar.',
        userAction:   'Cambia el método de pago a Transferencia Internacional.',
        retryable:    true,
      };
    }

    // IBAN format
    if (/IBAN|account.number.format/i.test(detailsStr)) {
      return {
        category:     'INVALID_ACCOUNT_FORMAT',
        adminMessage: `Formato IBAN/cuenta inválido: ${detailsStr}`,
        userMessage:  'El número de cuenta (IBAN o equivalente) tiene un formato inválido.',
        userAction:   'Verifica el IBAN/número de cuenta con el beneficiario. Para EU debe empezar con código país (ej. DE89...).',
        retryable:    true,
      };
    }

    // SWIFT/BIC format
    if (/SWIFT|BIC|swift_code.format/i.test(detailsStr)) {
      return {
        category:     'INVALID_SWIFT',
        adminMessage: `Formato SWIFT/BIC inválido: ${detailsStr}`,
        userMessage:  'El código SWIFT/BIC tiene un formato inválido (debe ser 8 u 11 caracteres en mayúsculas).',
        userAction:   'Verifica el SWIFT/BIC con el banco del beneficiario.',
        retryable:    true,
      };
    }

    // Phone number
    if (/phone_number|phone.format/i.test(detailsStr)) {
      return {
        category:     'INVALID_PHONE',
        adminMessage: `Número de teléfono inválido: ${detailsStr}`,
        userMessage:  'El número de teléfono no tiene el formato correcto (debe incluir prefijo internacional, ej. +971...).',
        userAction:   'Verifica el teléfono con el beneficiario.',
        retryable:    true,
      };
    }

    // Generic 3004 — banking partner rechazó por algo más
    return {
      category:     'WITHDRAWAL_REJECTED',
      adminMessage: `Banking partner rechazó: ${detailsStr || message}`,
      userMessage:  'El banco destino rechazó la transferencia con los datos proporcionados.',
      userAction:   'Verifica todos los datos del beneficiario (nombre, dirección, banco, cuenta).',
      retryable:    true,
    };
  }

  // ─── 3018 — Corredor no habilitado ───────────────────────────────────────
  if (code === 3018) {
    return {
      category:     'CORRIDOR_NOT_ENABLED',
      adminMessage: 'Corredor no habilitado para nuestro Harbor customer. Requiere amendment al Schedule C o activación admin OwlPay.',
      userMessage:  'Este destino no está disponible temporalmente. Estamos trabajando para habilitarlo.',
      userAction:   'Intenta otro destino o contacta soporte para urgencias.',
      retryable:    false,
    };
  }

  // ─── 2005 / 422 — Schema validation ──────────────────────────────────────
  if (code === 2005 || status === 422) {
    return {
      category:     'VALIDATION_ERROR',
      adminMessage: `Schema validation falló: ${detailsStr || message}. Errors: ${JSON.stringify(err.data?.errors ?? {})}`,
      userMessage:  'Algunos datos del beneficiario tienen formato inválido.',
      userAction:   'Revisa los datos del beneficiario y vuelve a intentar.',
      retryable:    true,
    };
  }

  // ─── 409 — Duplicado ─────────────────────────────────────────────────────
  if (status === 409) {
    return {
      category:     'DUPLICATE_TRANSFER',
      adminMessage: 'application_transfer_uuid duplicado en Harbor.',
      userMessage:  'Esta transferencia ya fue procesada anteriormente.',
      userAction:   'Verifica el estado en tu historial de transacciones.',
      retryable:    false,
    };
  }

  // ─── 401 — Auth ──────────────────────────────────────────────────────────
  if (status === 401) {
    return {
      category:     'AUTH_ERROR',
      adminMessage: 'API key Harbor inválida o expirada. Verificar OWLPAY_API_KEY.',
      userMessage:  'Hubo un problema interno procesando tu pago. Nuestro equipo ya fue notificado.',
      userAction:   'Intenta de nuevo en unos minutos.',
      retryable:    false,
    };
  }

  // ─── Saldo USDC insuficiente (error interno Alyto) ───────────────────────
  if (err.code === 'INSUFFICIENT_USDC' || /Insufficient USDC/i.test(message)) {
    return {
      category:     'INSUFFICIENT_LIQUIDITY',
      adminMessage: `Saldo USDC insuficiente en wallet SRL: ${message}`,
      userMessage:  'Estamos procesando tu pago. Recibirás notificación cuando se complete.',
      userAction:   'Sin acción necesaria — el equipo está fondeando la wallet.',
      retryable:    false,
    };
  }

  // ─── 5xx / network / timeout ─────────────────────────────────────────────
  if (err.isTransient || (status >= 500 && status < 600) || err.code === 'OWLPAY_TIMEOUT') {
    return {
      category:     'TRANSIENT_ERROR',
      adminMessage: `Error transitorio Harbor (reintentable): ${message}`,
      userMessage:  'Hubo un problema temporal procesando tu transferencia.',
      userAction:   'Intentaremos de nuevo automáticamente. Si persiste, contacta soporte.',
      retryable:    true,
    };
  }

  // ─── Fallback genérico ───────────────────────────────────────────────────
  return {
    category:     'UNKNOWN',
    adminMessage: `Error no clasificado: code=${code} status=${status} msg="${message}" details=${detailsStr}`,
    userMessage:  'No pudimos completar tu transferencia.',
    userAction:   'Nuestro equipo fue notificado. Contacta soporte si necesitas urgencia.',
    retryable:    true,
  };
}
