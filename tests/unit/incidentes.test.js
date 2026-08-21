/**
 * incidentes.test.js — Taxonomía de causas y plazos del registro de incidentes.
 *
 * Acredita los apartados 10.4 a 10.11 del informe técnico: que la causa de un fallo
 * se clasifica de forma estable, y que los plazos comprometidos ante ASFI se calculan
 * en lugar de recordarse.
 */

import {
  classifyFailure, isKnownFailureCategory, isCompensableDamage,
  groupByOrigin, FAILURE_CATEGORIES, FAILURE_CATALOG,
} from '../../src/utils/failureTaxonomy.js';

import { addBusinessDays, compensationRuleFor } from '../../src/services/incidentService.js';

describe('failureTaxonomy — el catálogo de causas', () => {

  it('reconoce las categorías que emiten los mappers de proveedor', () => {
    // Si un mapper deja de coincidir con el catálogo, esto falla antes que el conteo.
    for (const cat of ['INVALID_CPF', 'WITHDRAWAL_REJECTED', 'VITA_INVALID_FIELD',
                       'INSUFFICIENT_LIQUIDITY', 'HARBOR_BUG_SEPA']) {
      expect(isKnownFailureCategory(cat)).toBe(true);
    }
  });

  it('reconoce las categorías que se inventaban en línea fuera de los mappers', () => {
    for (const cat of ['BANKQR_EXPIRED', 'STALE_PAYOUT', 'STALE_TRANSIT',
                       'STELLAR_TRANSIT_EXHAUSTED', 'TRANSIENT_ERROR']) {
      expect(isKnownFailureCategory(cat)).toBe(true);
    }
  });

  it('no lanza ante una categoría desconocida: la resuelve y la marca sin reconocer', () => {
    // Perder el registro del fallo por no saber nombrar su causa sería peor.
    const r = classifyFailure('CATEGORIA_QUE_NO_EXISTE');
    expect(r.recognized).toBe(false);
    expect(r.category).toBe('UNKNOWN');
    expect(r.origin).toBe('unknown');
  });

  it('marca como reconocida una categoría del catálogo', () => {
    const r = classifyFailure('INVALID_CPF');
    expect(r.recognized).toBe(true);
    expect(r.consumerFix).toBe(true);
  });

  it('todas las entradas del catálogo declaran origen y corregibilidad', () => {
    for (const cat of FAILURE_CATEGORIES) {
      const e = FAILURE_CATALOG[cat];
      expect(typeof e.origin).toBe('string');
      expect(typeof e.consumerFix).toBe('boolean');
      expect(e.damageType === null || [1, 2, 3, 4].includes(e.damageType)).toBe(true);
    }
  });

  it('agrupa por origen para el informe mensual de incidencias', () => {
    const g = groupByOrigin(['INVALID_CPF', 'AUTH_ERROR', 'WITHDRAWAL_REJECTED']);
    expect(g.consumer).toContain('INVALID_CPF');
    expect(g.entity).toContain('AUTH_ERROR');
    expect(g.provider).toContain('WITHDRAWAL_REJECTED');
  });
});

describe('isCompensableDamage — sin cobro percibido no hay daño patrimonial', () => {

  it('un rechazo del proveedor CON cobro percibido es resarcible', () => {
    expect(isCompensableDamage({ category: 'WITHDRAWAL_REJECTED', payinConfirmed: true })).toBe(true);
  });

  it('el mismo rechazo SIN cobro percibido no lo es', () => {
    // Apdo. 10.2.1: la superficie de daño se limita a fondos ya recibidos.
    expect(isCompensableDamage({ category: 'WITHDRAWAL_REJECTED', payinConfirmed: false })).toBe(false);
  });

  it('un dato mal ingresado no es daño patrimonial aunque haya cobro', () => {
    expect(isCompensableDamage({ category: 'INVALID_CPF', payinConfirmed: true })).toBe(false);
  });

  it('una expiración sin pago no es daño', () => {
    expect(isCompensableDamage({ category: 'BANKQR_EXPIRED', payinConfirmed: false })).toBe(false);
  });
});

describe('addBusinessDays — los plazos se calculan, no se recuerdan', () => {

  it('salta el fin de semana hacia adelante', () => {
    // viernes 21/08/2026 + 1 hábil = lunes 24
    const viernes = new Date('2026-08-21T12:00:00');
    expect(viernes.getDay()).toBe(5);
    const r = addBusinessDays(viernes, 1);
    expect(r.getDay()).toBe(1);
    expect(r.getDate()).toBe(24);
  });

  it('cuenta tres días hábiles cruzando el fin de semana', () => {
    // jueves 20/08 + 3 hábiles = martes 25 (vi 21, lu 24, ma 25)
    const jueves = new Date('2026-08-20T12:00:00');
    const r = addBusinessDays(jueves, 3);
    expect(r.getDate()).toBe(25);
  });

  it('resta días hábiles con valores negativos', () => {
    // Sin esto, el vencimiento de la determinación nunca dispararía.
    const lunes = new Date('2026-08-24T12:00:00');
    const r = addBusinessDays(lunes, -2);
    expect(r.getDay()).toBe(4);   // jueves 20
    expect(r.getDate()).toBe(20);
  });

  it('devuelve la misma fecha con cero', () => {
    const d = new Date('2026-08-21T12:00:00');
    expect(addBusinessDays(d, 0).getTime()).toBe(d.getTime());
  });

  it('no muta la fecha recibida', () => {
    const d = new Date('2026-08-21T12:00:00');
    const antes = d.getTime();
    addBusinessDays(d, 5);
    expect(d.getTime()).toBe(antes);
  });
});

describe('compensationRuleFor — las modalidades del apartado 10.8.1', () => {

  it.each([
    ['pago_no_ejecutado',      'devolucion_integra', 3],
    ['monto_inferior',         'complemento',        2],
    ['deposito_no_acreditado', 'acreditacion',       1],
    ['restriccion_indebida',   'liberacion',         1],
  ])('%s → %s en %i días hábiles', (tipo, modalidad, dias) => {
    const r = compensationRuleFor(tipo);
    expect(r.modality).toBe(modalidad);
    expect(r.businessDays).toBe(dias);
  });

  it('los tipos no patrimoniales no tienen modalidad de resarcimiento', () => {
    expect(compensationRuleFor('indisponibilidad')).toBeNull();
    expect(compensationRuleFor('datos_personales')).toBeNull();
  });
});
