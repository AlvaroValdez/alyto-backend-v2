/**
 * contacts.test.js (integración) — Guardar y reutilizar contactos.
 *
 * El contacto queda ANCLADO AL CORREDOR, no a lo que diga el cliente: formType y
 * destinationCurrency se estampan del corredor vigente al crear Y al reescribir
 * los datos del beneficiario. Es la pieza que mantiene coherentes el formulario
 * que la persona llenó y el sello con el que el prefill del paso 3 decide si
 * puede volcar los datos.
 *
 * El caso que motivó el re-estampado en PUT (2026-10-05): un corredor migra de
 * proveedor (EU Harbor→Vita en agosto; bo-br igual hoy), el usuario EDITA el
 * contacto — el formulario de edición renderiza los campos del proveedor
 * VIGENTE — y el guardado dejaba datos frescos con sello viejo: el paso 3 lo
 * rechazaba como "formato anterior" aunque se acabara de actualizar.
 */

import '../setup.env.js';

import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';
import { createSRLUser } from '../helpers/auth.js';

const { default: app }               = await import('../../src/server.js');
const { default: request }           = await import('supertest');
const { default: Contact }           = await import('../../src/models/Contact.js');
const { default: TransactionConfig } = await import('../../src/models/TransactionConfig.js');

// ─── Corredores de prueba ─────────────────────────────────────────────────────

/** bo-br tal como quedó el 2026-10-05: Vita, BRL, PIX. */
async function seedBrVita(overrides = {}) {
  return TransactionConfig.create({
    corridorId:          'bo-br',
    originCountry:       'BO',
    destinationCountry:  'BR',
    originCurrency:      'BOB',
    destinationCurrency: 'BRL',
    payinMethod:         'manual',
    payoutMethod:        'vitaWallet',
    legalEntity:         'SRL',
    routingScenario:     'C',
    alytoCSpread:        6.5,
    fixedFee:            6,
    payinFeePercent:     0,
    payoutFeeFixed:      0,
    profitRetentionPercent: 0,
    minAmountOrigin:     240,
    minAmountUSD:        20,
    isActive:            true,
    ...overrides,
  });
}

/** bo-us: Harbor, USD. */
async function seedUsHarbor(overrides = {}) {
  return TransactionConfig.create({
    corridorId:          'bo-us',
    originCountry:       'BO',
    destinationCountry:  'US',
    originCurrency:      'BOB',
    destinationCurrency: 'USD',
    payinMethod:         'manual',
    payoutMethod:        'owlPay',
    legalEntity:         'SRL',
    routingScenario:     'C',
    alytoCSpread:        6.5,
    fixedFee:            6,
    payinFeePercent:     0,
    payoutFeeFixed:      0,
    profitRetentionPercent: 0,
    minAmountOrigin:     663,
    minAmountUSD:        40,
    isActive:            true,
    ...overrides,
  });
}

const CHAVE_PIX = {
  beneficiary_first_name:    'Ana',
  beneficiary_last_name:     'Silva',
  beneficiary_document_type: 'CPF',
  beneficiary_document_number: '39053344705',
  pix_key_type:              'cpf',
  account_bank__code_cpf:    '39053344705',
};

function postContact(token, body) {
  return request(app)
    .post('/api/v1/contacts')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function putContact(token, id, body) {
  return request(app)
    .put(`/api/v1/contacts/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearCollections);

// ─── Crear ────────────────────────────────────────────────────────────────────

describe('POST /contacts — el corredor manda, no el cliente', () => {
  test('estampa formType y moneda del corredor aunque el cliente mienta', async () => {
    await seedBrVita();
    const { token } = await createSRLUser();

    const res = await postContact(token, {
      nickname:            'Ana PIX',
      destinationCountry:  'BR',
      destinationCurrency: 'JPY',       // mentira del cliente
      formType:            'owlpay',    // mentira del cliente (BR es Vita desde 2026-10-05)
      beneficiaryData:     CHAVE_PIX,
    });

    expect(res.status).toBe(201);
    expect(res.body.contact.formType).toBe('vita');            // del corredor
    expect(res.body.contact.destinationCurrency).toBe('BRL');  // del corredor
  });

  test('destino sin corredor activo → 400 y no persiste nada (caso JP hoy)', async () => {
    // JP no se siembra: quedó desactivado el 2026-10-05.
    const { token, user } = await createSRLUser();

    const res = await postContact(token, {
      destinationCountry: 'JP',
      formType:           'owlpay',
      beneficiaryData:    { account_holder_name: 'Yamamoto Taro' },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/corredor activo/i);
    expect(await Contact.countDocuments({ userId: user._id })).toBe(0);
  });

  test('la misma chave PIX dos veces → 409 con el contactId existente', async () => {
    await seedBrVita();
    const { token } = await createSRLUser();

    const primero = await postContact(token, {
      destinationCountry: 'BR', formType: 'vita', beneficiaryData: CHAVE_PIX,
    });
    expect(primero.status).toBe(201);

    const repetido = await postContact(token, {
      destinationCountry: 'BR', formType: 'vita',
      beneficiaryData: { ...CHAVE_PIX, beneficiary_first_name: 'Ana María' },
    });
    expect(repetido.status).toBe(409);
    expect(repetido.body.contactId).toBe(primero.body.contact._id);
  });

  test('el dedupe es por usuario: otro usuario puede guardar la misma chave', async () => {
    await seedBrVita();
    const a = await createSRLUser();
    const b = await createSRLUser();

    const r1 = await postContact(a.token, { destinationCountry: 'BR', formType: 'vita', beneficiaryData: CHAVE_PIX });
    const r2 = await postContact(b.token, { destinationCountry: 'BR', formType: 'vita', beneficiaryData: CHAVE_PIX });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
  });

  test('sin token → 401', async () => {
    const res = await request(app).post('/api/v1/contacts')
      .send({ destinationCountry: 'BR', formType: 'vita', beneficiaryData: CHAVE_PIX });
    expect(res.status).toBe(401);
  });
});

// ─── Editar: el caso de la migración de proveedor ─────────────────────────────

describe('PUT /contacts/:id — re-estampado al reescribir beneficiaryData', () => {
  test('corredor migró de proveedor → editar los datos actualiza también el sello', async () => {
    // 1. El contacto nace bajo Harbor (como los contactos EU pre-agosto, o un
    //    BR hipotético guardado antes del 2026-10-05).
    const harbor = await seedBrVita({ payoutMethod: 'owlPay', destinationCurrency: 'USD' });
    const { token } = await createSRLUser();

    const creado = await postContact(token, {
      destinationCountry: 'BR', formType: 'owlpay',
      beneficiaryData: { br_cpf: '39053344705', email: 'ana@test.io' },
    });
    expect(creado.body.contact.formType).toBe('owlpay');

    // 2. El corredor migra a Vita (lo que pasó de verdad con bo-br).
    await TransactionConfig.updateOne(
      { _id: harbor._id },
      { $set: { payoutMethod: 'vitaWallet', destinationCurrency: 'BRL' } },
    );

    // 3. El usuario edita el contacto. El formulario de edición ya es el de Vita,
    //    así que manda datos en formato Vita.
    const editado = await putContact(token, creado.body.contact._id, {
      beneficiaryData: CHAVE_PIX,
    });

    expect(editado.status).toBe(200);
    // Sin el re-estampado esto quedaba 'owlpay': datos frescos con sello viejo,
    // y el prefill del paso 3 los rechazaba como "formato anterior".
    expect(editado.body.contact.formType).toBe('vita');
    expect(editado.body.contact.destinationCurrency).toBe('BRL');
  });

  test('editar solo el apodo NO toca el sello ni exige corredor activo', async () => {
    await seedBrVita();
    const { token } = await createSRLUser();
    const creado = await postContact(token, {
      destinationCountry: 'BR', formType: 'vita', beneficiaryData: CHAVE_PIX,
    });

    // El corredor se apaga después de guardar (lo que pasó con JP).
    await TransactionConfig.updateOne({ corridorId: 'bo-br' }, { $set: { isActive: false } });

    const editado = await putContact(token, creado.body.contact._id, { nickname: 'Anita' });
    expect(editado.status).toBe(200);
    expect(editado.body.contact.nickname).toBe('Anita');
    expect(editado.body.contact.formType).toBe('vita');   // intacto
  });

  test('reescribir datos con el destino inactivo conserva el sello (no hay form nuevo)', async () => {
    await seedBrVita();
    const { token } = await createSRLUser();
    const creado = await postContact(token, {
      destinationCountry: 'BR', formType: 'vita', beneficiaryData: CHAVE_PIX,
    });
    await TransactionConfig.updateOne({ corridorId: 'bo-br' }, { $set: { isActive: false } });

    const editado = await putContact(token, creado.body.contact._id, {
      beneficiaryData: { ...CHAVE_PIX, account_bank__code_cpf: '52998224725' },
    });
    expect(editado.status).toBe(200);
    expect(editado.body.contact.formType).toBe('vita');
  });

  test('no se puede editar el contacto de otro usuario', async () => {
    await seedBrVita();
    const a = await createSRLUser();
    const b = await createSRLUser();
    const creado = await postContact(a.token, {
      destinationCountry: 'BR', formType: 'vita', beneficiaryData: CHAVE_PIX,
    });

    const ajeno = await putContact(b.token, creado.body.contact._id, { nickname: 'mío ahora' });
    expect(ajeno.status).toBe(404);
  });
});

// ─── Listar ───────────────────────────────────────────────────────────────────

describe('GET /contacts', () => {
  test('?country=EU incluye los contactos legacy guardados como ES', async () => {
    const { user, token } = await createSRLUser();
    await Contact.create([
      { userId: user._id, destinationCountry: 'ES', formType: 'vita', beneficiaryData: { iban: 'ES9121000418450200051332' } },
      { userId: user._id, destinationCountry: 'EU', formType: 'vita', beneficiaryData: { iban: 'DE89370400440532013000' } },
      { userId: user._id, destinationCountry: 'BR', formType: 'vita', beneficiaryData: CHAVE_PIX },
    ]);

    const res = await request(app).get('/api/v1/contacts?country=EU')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(2);
    const paises = res.body.contacts.map(c => c.destinationCountry).sort();
    expect(paises).toEqual(['ES', 'EU']);
  });

  test('cada usuario ve solo lo suyo', async () => {
    const a = await createSRLUser();
    const b = await createSRLUser();
    await Contact.create({ userId: a.user._id, destinationCountry: 'BR', formType: 'vita', beneficiaryData: CHAVE_PIX });

    const res = await request(app).get('/api/v1/contacts')
      .set('Authorization', `Bearer ${b.token}`);
    expect(res.body.contacts).toHaveLength(0);
  });
});
