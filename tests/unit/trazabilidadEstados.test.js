/**
 * trazabilidadEstados.test.js — Sucesión cronológica de estados de la operación.
 *
 * Acredita la limitación 1 del apartado 7.10 del informe técnico: que el paso de un
 * estado a otro queda asentado con su momento y su motivo, en lugar de inferirse
 * cruzando etapas de pago y avisos de proveedor.
 */

import { buildStatusEntry } from '../../src/utils/statusTrail.js';

describe('buildStatusEntry — qué se asienta y qué no', () => {

  it('asienta el estado inicial al crear la operación', () => {
    const e = buildStatusEntry({ isNew: true, prevStatus: undefined, nextStatus: 'payin_pending' });
    expect(e.from).toBeNull();
    expect(e.to).toBe('payin_pending');
    expect(e.reason).toMatch(/Creación/);
  });

  it('asienta la transición entre dos estados', () => {
    const e = buildStatusEntry({ isNew: false, prevStatus: 'payin_pending', nextStatus: 'payin_confirmed' });
    expect(e.from).toBe('payin_pending');
    expect(e.to).toBe('payin_confirmed');
    expect(e.at).toBeInstanceOf(Date);
  });

  it('no asienta nada si el estado no cambió', () => {
    // Un guardado que toca otros campos no debe inflar la sucesión con repeticiones.
    expect(buildStatusEntry({ isNew: false, prevStatus: 'processing', nextStatus: 'processing' })).toBeNull();
  });

  it('no asienta nada si no hay estado destino', () => {
    expect(buildStatusEntry({ isNew: false, prevStatus: 'processing', nextStatus: undefined })).toBeNull();
  });

  it('captura el motivo junto a la transición', () => {
    // Importa porque `statusReason` lo sobrescribe el cambio siguiente: si el motivo
    // no viaja con la transición, se pierde.
    const e = buildStatusEntry({
      isNew: false, prevStatus: 'payout_sent', nextStatus: 'failed',
      reason: 'Rechazo de la red de liquidación en destino',
      category: 'WITHDRAWAL_REJECTED',
    });
    expect(e.reason).toMatch(/Rechazo de la red/);
    expect(e.category).toBe('WITHDRAWAL_REJECTED');
  });

  it('normaliza el motivo ausente a cadena vacía, no a indefinido', () => {
    const e = buildStatusEntry({ isNew: false, prevStatus: 'a', nextStatus: 'b' });
    expect(e.reason).toBe('');
    expect(e.category).toBeNull();
  });

  it('trata un estado previo indefinido como origen nulo', () => {
    const e = buildStatusEntry({ isNew: false, prevStatus: undefined, nextStatus: 'completed' });
    expect(e.from).toBeNull();
    expect(e.to).toBe('completed');
  });

  it('el asiento de creación ignora motivo y categoría recibidos', () => {
    const e = buildStatusEntry({
      isNew: true, prevStatus: undefined, nextStatus: 'payin_pending',
      reason: 'algo', category: 'UNKNOWN',
    });
    expect(e.reason).toMatch(/Creación/);
    expect(e.category).toBeNull();
  });

  it('respeta el instante recibido, para poder fechar de forma determinista', () => {
    const t = new Date('2026-08-21T10:00:00Z');
    const e = buildStatusEntry({ isNew: false, prevStatus: 'a', nextStatus: 'b', now: t });
    expect(e.at.getTime()).toBe(t.getTime());
  });

  it('reconstruye un recorrido completo encadenado', () => {
    const recorrido = ['payin_pending', 'payin_confirmed', 'processing', 'payout_sent', 'completed'];
    const historia = [];
    let anterior;

    recorrido.forEach((estado, i) => {
      const e = buildStatusEntry({ isNew: i === 0, prevStatus: anterior, nextStatus: estado });
      if (e) historia.push(e);
      anterior = estado;
    });

    expect(historia.map(h => h.to)).toEqual(recorrido);
    // El destino de cada asiento es el origen del siguiente.
    for (let i = 1; i < historia.length; i++) {
      expect(historia[i].from).toBe(historia[i - 1].to);
    }
  });
});
