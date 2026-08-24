/**
 * seedAdminGuard.test.js — La guarda de `scripts/seedAdmin.js`.
 *
 * La prueba que importa es la primera: una cuenta con rol de administración se
 * rehúsa incluso pidiendo recrear de forma explícita. Si esa aserción cae, el
 * script vuelve a poder destruir la cuenta cuyo rastro el apdo. 7.4.2 declara.
 */

import { decideSeedAction } from '../../scripts/seedAdminGuard.js';

describe('cuenta con rol de administración', () => {

  it('se rehúsa, y no hay override que lo habilite', () => {
    for (const recrear of [false, true]) {
      const d = decideSeedAction({ role: 'admin' }, recrear);
      expect(d.action).toBe('refuse');
      expect(d.reason).toBe('ADMIN_ACCOUNT_EXISTS');
    }
  });
});

describe('cuenta existente sin privilegios', () => {

  it('se rehúsa por defecto', () => {
    const d = decideSeedAction({ role: 'user' }, false);
    expect(d.action).toBe('refuse');
    expect(d.reason).toBe('ACCOUNT_EXISTS');
  });

  it('se recrea sólo con la petición explícita', () => {
    const d = decideSeedAction({ role: 'user' }, true);
    expect(d.action).toBe('recreate');
    expect(d.reason).toBeNull();
  });
});

describe('entorno limpio', () => {

  it('crea cuando no hay cuenta previa', () => {
    expect(decideSeedAction(null, false).action).toBe('create');
  });

  it('la petición de recrear no cambia nada si no hay cuenta previa', () => {
    expect(decideSeedAction(null, true).action).toBe('create');
  });
});

describe('el rol desconocido no abre la rama destructiva sin pedirlo', () => {

  it.each([undefined, '', 'operador', 'compliance'])('rol %p', (role) => {
    expect(decideSeedAction({ role }, false).action).toBe('refuse');
  });
});
