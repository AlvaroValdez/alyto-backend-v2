/**
 * clientDuplicateAlert.test.js — Reconocer a la misma persona en dos cuentas.
 *
 * Lo que se protege acá no es un cálculo sino la **posibilidad** de detectar el
 * duplicado. El CI se guarda cifrado con IV aleatorio y AAD atado al usuario, así
 * que dos cuentas con el mismo documento tienen ciphertexts distintos y ninguna
 * consulta las empareja. Toda la detección depende de que la huella determinista
 * sí coincida: si esa propiedad se rompe —por un cambio en la normalización, en la
 * derivación de la clave, o porque alguien calcule la huella sobre el campo
 * `number` en vez del valor en claro— el sistema deja de ver duplicados y **no
 * falla**, simplemente no avisa nunca. Es el modo de fallo silencioso que estas
 * pruebas existen para delatar.
 *
 * El caso de la primera prueba es el real de producción (2026-10-10): la misma
 * persona con dos cuentas aprobadas y dos verificaciones de Stripe pagadas.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';

// El cifrado PII tiene que estar operativo en la suite: sin DEK la huella es null y
// las pruebas de documento pasarían en verde sin comprobar nada. El fallback local
// está hard-gateado contra producción mainnet, así que acá es seguro.
process.env.PII_KMS_FALLBACK      = 'true';
process.env.PII_FALLBACK_KEY      = 'clave_de_pruebas_para_la_dek_no_usar_en_prod';
process.env.PII_ENCRYPTION_ENABLED = 'true';

import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';

const mockNotifyAdmins = jest.fn();
await jest.unstable_mockModule('../../src/services/notifications.js', () => ({
  notifyAdmins: mockNotifyAdmins,
  notify:       jest.fn(),
}));

const mockSendRaw = jest.fn();
await jest.unstable_mockModule('../../src/services/email.js', () => ({
  sendRawEmail: mockSendRaw,
}));

const { default: User } = await import('../../src/models/User.js');
const { resolveDocumentNumberStorage } = await import('../../src/utils/clientDocument.js');
const { readDocumentNumber } = await import('../../src/utils/clientDocument.js');
const {
  normalizeDocumentNumber, documentFingerprint, phoneTail,
} = await import('../../src/services/clientIdentityIndex.js');
const { buscarCoincidencias, revisarClienteDuplicado } =
  await import('../../src/services/clientDuplicateAlert.js');
const mongoose = (await import('mongoose')).default;

/** Crea un usuario con el CI pasando por el MISMO camino de escritura que producción. */
async function crearUsuario({ email, documentNumber = '', phone = undefined, kycStatus = 'approved' }) {
  const _id   = new mongoose.Types.ObjectId();
  const store = await resolveDocumentNumberStorage(_id, documentNumber);
  return User.create({
    _id,
    firstName: 'Ghilmar',
    lastName:  'Valeriano',
    email,
    phone,
    phoneTail: phoneTail(phone) ?? undefined,
    password:  'x'.repeat(20),
    legalEntity: 'SRL',
    kycStatus,
    residenceCountry: 'BO',
    identityDocument: {
      type:              'ci_bolivia',
      number:            store.number,
      numberCiphertext:  store.numberCiphertext ?? undefined,
      numberFingerprint: store.numberFingerprint ?? undefined,
      issuingCountry:    'BO',
    },
  });
}

beforeAll(async () => { await connectTestDb(); });
afterAll(async () => { await disconnectTestDb(); });
beforeEach(async () => {
  await clearCollections();
  mockNotifyAdmins.mockReset();
  mockSendRaw.mockReset();
});

describe('normalizeDocumentNumber', () => {
  it('colapsa los formatos del mismo documento en una sola forma', () => {
    const esperado = normalizeDocumentNumber('12345671A');
    expect(normalizeDocumentNumber('1234567-1A')).toBe(esperado);
    expect(normalizeDocumentNumber('1.234.567 1a')).toBe(esperado);
    expect(normalizeDocumentNumber('  12345671a  ')).toBe(esperado);
  });

  it('rechaza marcadores y valores demasiado cortos', () => {
    expect(normalizeDocumentNumber('PENDING_VERIFICATION')).toBeNull();
    expect(normalizeDocumentNumber('ENCRYPTED')).toBeNull();
    expect(normalizeDocumentNumber('123')).toBeNull();
    expect(normalizeDocumentNumber('')).toBeNull();
    expect(normalizeDocumentNumber(null)).toBeNull();
  });

  it('rechaza un ciphertext: calcular su huella agruparía a usuarios distintos', () => {
    // El modo de fallo concreto: alguien pasa `identityDocument.number` creyendo que
    // es el número. Con el cifrado activo ese campo vale 'ENCRYPTED' para todos, y
    // una huella sobre un ciphertext sería una clave basura pero consistente.
    expect(normalizeDocumentNumber('v1:AAAAbbbbCCCCdddd==')).toBeNull();
  });
});

describe('phoneTail', () => {
  it('iguala el mismo número escrito con y sin prefijo', () => {
    expect(phoneTail('+59169769901')).toBe(phoneTail('69769901'));
    expect(phoneTail('+591 697 699 01')).toBe(phoneTail('69769901'));
  });

  it('distingue números distintos y descarta lo que no es un teléfono', () => {
    expect(phoneTail('+59169769901')).not.toBe(phoneTail('+59162071258'));
    expect(phoneTail('123')).toBeNull();
    expect(phoneTail(null)).toBeNull();
  });
});

describe('documentFingerprint', () => {
  it('es determinista y distinta por documento', async () => {
    const a = await documentFingerprint('6174131');
    const b = await documentFingerprint('6174131');
    const c = await documentFingerprint('14330719');
    expect(a).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('no es un hash pelado del número: depende de la clave', async () => {
    const crypto = await import('node:crypto');
    const sha = crypto.createHash('sha256').update('6174131').digest('hex');
    expect(await documentFingerprint('6174131')).not.toBe(sha);
  });
});

describe('buscarCoincidencias', () => {
  it('encuentra el mismo documento aunque los ciphertexts sean distintos', async () => {
    const vieja = await crearUsuario({ email: 'gmamaniv@fcpn.edu.bo', documentNumber: '9183746' });
    const nueva = await crearUsuario({ email: 'davidmamanivaleriano3@gmail.com', documentNumber: '9183746' });

    // Premisa de todo el diseño: el campo guardado NO permite la comparación.
    const [cv, cn] = await Promise.all([
      User.findById(vieja._id).select('+identityDocument.numberCiphertext').lean(),
      User.findById(nueva._id).select('+identityDocument.numberCiphertext').lean(),
    ]);
    expect(cv.identityDocument.numberCiphertext)
      .not.toBe(cn.identityDocument.numberCiphertext);
    expect(readDocumentNumber(cv)).toBe(readDocumentNumber(cn));

    const { motivos, coincidencias } = await buscarCoincidencias(nueva, { documentNumber: '9183746' });
    expect(motivos).toContain('documento');
    expect(coincidencias).toHaveLength(1);
    expect(coincidencias[0].email).toBe('gmamaniv@fcpn.edu.bo');
    expect(coincidencias[0].porDocumento).toBe(true);
  });

  it('encuentra el mismo teléfono escrito distinto', async () => {
    await crearUsuario({ email: 'uno@ejemplo.bo', phone: '+59169769901' });
    const nueva = await crearUsuario({ email: 'dos@ejemplo.bo', phone: '69769901' });

    const { motivos, coincidencias } = await buscarCoincidencias(nueva, { phone: '69769901' });
    expect(motivos).toEqual(['telefono']);
    expect(coincidencias[0].email).toBe('uno@ejemplo.bo');
    expect(coincidencias[0].porTelefono).toBe(true);
  });

  it('no se reporta a sí misma', async () => {
    const sola = await crearUsuario({ email: 'sola@ejemplo.bo', documentNumber: '9183746', phone: '+59169769901' });
    const r = await buscarCoincidencias(sola, { documentNumber: '9183746', phone: '+59169769901' });
    expect(r.motivos).toEqual([]);
    expect(r.coincidencias).toEqual([]);
  });

  it('no agrupa a los usuarios que todavía no declararon su CI', async () => {
    // Antes del cifrado el campo valía 'PENDING_VERIFICATION' para medio padrón: una
    // comparación ingenua los habría declarado todos duplicados entre sí.
    await crearUsuario({ email: 'a@ejemplo.bo' });
    await crearUsuario({ email: 'b@ejemplo.bo' });
    const nueva = await crearUsuario({ email: 'c@ejemplo.bo' });
    const r = await buscarCoincidencias(nueva, { documentNumber: '', phone: undefined });
    expect(r.motivos).toEqual([]);
  });
});

describe('revisarClienteDuplicado', () => {
  it('avisa a administración una sola vez por cuenta y motivo', async () => {
    await crearUsuario({ email: 'vieja@ejemplo.bo', documentNumber: '9183746' });
    const nueva = await crearUsuario({ email: 'nueva@ejemplo.bo', documentNumber: '9183746' });

    const primera = await revisarClienteDuplicado(nueva, { documentNumber: '9183746', origen: 'registro' });
    expect(primera).toMatchObject({ duplicado: true, alertado: true });
    expect(mockNotifyAdmins).toHaveBeenCalledTimes(1);
    expect(mockNotifyAdmins.mock.calls[0][0].data.type).toBe('admin_cliente_duplicado');
    expect(mockSendRaw).toHaveBeenCalledTimes(1);

    const segunda = await revisarClienteDuplicado(nueva, { documentNumber: '9183746', origen: 'registro' });
    expect(segunda).toMatchObject({ duplicado: true, alertado: false });
    expect(mockNotifyAdmins).toHaveBeenCalledTimes(1); // el cooldown lo frenó
  });

  it('el correo al administrador NUNCA lleva el número de documento', async () => {
    await crearUsuario({ email: 'vieja@ejemplo.bo', documentNumber: '9183746' });
    const nueva = await crearUsuario({ email: 'nueva@ejemplo.bo', documentNumber: '9183746' });
    await revisarClienteDuplicado(nueva, { documentNumber: '9183746', origen: 'registro' });

    const [, asunto, html] = mockSendRaw.mock.calls[0];
    expect(`${asunto} ${html}`).not.toContain('9183746');
    expect(html).toContain('vieja@ejemplo.bo');
  });

  it('el aviso por teléfono no bloquea el del documento, que llega después', async () => {
    // Secuencia real: en el registro solo coincide el teléfono; el CI entra recién en
    // el perfil de cumplimiento. Con un cooldown por usuario, la señal fuerte quedaría
    // silenciada por la débil y nadie se enteraría del duplicado de verdad.
    await crearUsuario({ email: 'vieja@ejemplo.bo', documentNumber: '9183746', phone: '+59169769901' });
    const nueva = await crearUsuario({ email: 'nueva@ejemplo.bo', phone: '+59169769901' });

    await revisarClienteDuplicado(nueva, { phone: '+59169769901', origen: 'registro' });
    expect(mockNotifyAdmins).toHaveBeenCalledTimes(1);

    await revisarClienteDuplicado(nueva, {
      documentNumber: '9183746', phone: '+59169769901', origen: 'perfil de cumplimiento',
    });
    expect(mockNotifyAdmins).toHaveBeenCalledTimes(2);
  });

  it('nunca lanza: un fallo de la detección no puede tumbar un registro', async () => {
    const nueva = await crearUsuario({ email: 'nueva@ejemplo.bo', documentNumber: '9183746' });
    mockNotifyAdmins.mockRejectedValueOnce(new Error('SendGrid caído'));
    await crearUsuario({ email: 'vieja@ejemplo.bo', documentNumber: '9183746' });

    await expect(
      revisarClienteDuplicado(nueva, { documentNumber: '9183746', origen: 'registro' }),
    ).resolves.toEqual({ duplicado: false });
  });

  it('se puede apagar por entorno sin tocar código', async () => {
    await crearUsuario({ email: 'vieja@ejemplo.bo', documentNumber: '9183746' });
    const nueva = await crearUsuario({ email: 'nueva@ejemplo.bo', documentNumber: '9183746' });

    process.env.CLIENT_DUPLICATE_ALERT_ENABLED = 'false';
    try {
      const r = await revisarClienteDuplicado(nueva, { documentNumber: '9183746' });
      expect(r).toEqual({ duplicado: false });
      expect(mockNotifyAdmins).not.toHaveBeenCalled();
    } finally {
      delete process.env.CLIENT_DUPLICATE_ALERT_ENABLED;
    }
  });
});
