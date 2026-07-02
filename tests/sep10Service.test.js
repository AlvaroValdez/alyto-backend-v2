/**
 * sep10Service.test.js — Tests SEP-10 Web Authentication
 *
 * Cubre el hardening de verifyChallenge (2026-07):
 *   - Roundtrip feliz: buildChallenge → firma cliente → verifyChallenge emite JWT
 *   - El challenge emitido cumple spec: sequence 0, firmado por el servidor
 *   - Rechazos: challenge fabricado (sin firma servidor), source ajeno,
 *     sequence != 0, home_domain distinto, expirado, sin firma del cliente
 */

import './setup.env.js';
import jwt from 'jsonwebtoken';
import {
  Keypair,
  TransactionBuilder,
  Operation,
  Transaction,
  Account,
} from '@stellar/stellar-sdk';

import { connectTestDb, disconnectTestDb } from './helpers/db.js';

// setup.env.js define un STELLAR_SRL_SECRET_KEY placeholder inválido — para SEP-10
// necesitamos un keypair real (efímero de test) ANTES de importar el service.
const serverKeypair = Keypair.random();
process.env.STELLAR_SRL_SECRET_KEY = serverKeypair.secret();

const { buildChallenge, verifyChallenge } = await import('../src/services/sep10Service.js');
const { NETWORK_PASSPHRASE } = await import('../src/config/stellar.js');

const HOME_DOMAIN = process.env.HOME_DOMAIN ?? 'alyto.app';

/** Firma el XDR del challenge con el keypair del cliente y devuelve el XDR firmado. */
function clientSign(challengeXdr, clientKeypair) {
  const tx = new Transaction(challengeXdr, NETWORK_PASSPHRASE);
  tx.sign(clientKeypair);
  return tx.toEnvelope().toXDR('base64');
}

/** Construye un challenge FALSO (no emitido por el servidor). */
function buildForgedChallenge({
  sourcePublicKey = serverKeypair.publicKey(),
  clientKeypair,
  opName = `${HOME_DOMAIN} auth`,
  startingSequence = '-1',
  minTime = Math.floor(Date.now() / 1000),
  maxTime = Math.floor(Date.now() / 1000) + 900,
  signers = [clientKeypair],
} = {}) {
  const account = new Account(sourcePublicKey, startingSequence);
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
    timebounds: { minTime, maxTime },
  })
    .addOperation(Operation.manageData({
      name:   opName,
      value:  Buffer.from('forged-nonce'),
      source: clientKeypair.publicKey(),
    }))
    .build();

  for (const signer of signers) tx.sign(signer);
  return tx.toEnvelope().toXDR('base64');
}

beforeAll(async () => { await connectTestDb(); });
afterAll(async () => { await disconnectTestDb(); });

describe('SEP-10 buildChallenge', () => {
  it('emite un challenge con sequence 0 (spec) firmado por el servidor', async () => {
    const client = Keypair.random();
    const { transaction, network_passphrase } = await buildChallenge(client.publicKey());

    expect(network_passphrase).toBe(NETWORK_PASSPHRASE);

    const tx = new Transaction(transaction, NETWORK_PASSPHRASE);
    expect(String(tx.sequence)).toBe('0');
    expect(tx.source).toBe(serverKeypair.publicKey());
    expect(tx.operations[0].type).toBe('manageData');
    expect(tx.operations[0].name).toBe(`${HOME_DOMAIN} auth`);
    expect(tx.operations[0].source).toBe(client.publicKey());

    // Firma del servidor presente
    const txHash = tx.hash();
    const serverSigned = tx.signatures.some(sig => {
      try { return serverKeypair.verify(txHash, sig.signature()); }
      catch { return false; }
    });
    expect(serverSigned).toBe(true);
  });

  it('rechaza un account ID inválido', async () => {
    await expect(buildChallenge('not-a-key')).rejects.toThrow('Invalid Stellar account ID');
  });
});

describe('SEP-10 verifyChallenge', () => {
  it('roundtrip feliz: challenge del servidor + firma cliente → JWT', async () => {
    const client = Keypair.random();
    const { transaction } = await buildChallenge(client.publicKey());
    const signedXdr = clientSign(transaction, client);

    const { token } = await verifyChallenge(signedXdr);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    expect(decoded.stellarAccount).toBe(client.publicKey());
  });

  it('rechaza un challenge sin la firma del servidor (fabricado por el cliente)', async () => {
    const client = Keypair.random();
    const forged = buildForgedChallenge({ clientKeypair: client });
    await expect(verifyChallenge(forged)).rejects.toThrow('Challenge not signed by server');
  });

  it('rechaza un challenge cuyo source NO es el SIGNING_KEY del servidor', async () => {
    const client   = Keypair.random();
    const attacker = Keypair.random();
    const forged = buildForgedChallenge({
      sourcePublicKey: attacker.publicKey(),
      clientKeypair:   client,
      signers:         [attacker, client],
    });
    await expect(verifyChallenge(forged)).rejects.toThrow('Challenge not issued by this server');
  });

  it('rechaza un challenge con sequence != 0', async () => {
    const client = Keypair.random();
    const forged = buildForgedChallenge({
      clientKeypair:    client,
      startingSequence: '41',                       // → tx sequence 42
      signers:          [serverKeypair, client],    // incluso firmado por el servidor
    });
    await expect(verifyChallenge(forged)).rejects.toThrow('sequence number must be 0');
  });

  it('rechaza un challenge con home_domain ajeno', async () => {
    const client = Keypair.random();
    const forged = buildForgedChallenge({
      clientKeypair: client,
      opName:        'evil.example auth',
      signers:       [serverKeypair, client],
    });
    await expect(verifyChallenge(forged)).rejects.toThrow('home domain mismatch');
  });

  it('rechaza un challenge expirado', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const client = Keypair.random();
    const forged = buildForgedChallenge({
      clientKeypair: client,
      minTime:       nowSec - 2000,
      maxTime:       nowSec - 1000,
      signers:       [serverKeypair, client],
    });
    await expect(verifyChallenge(forged)).rejects.toThrow('expired');
  });

  it('rechaza un challenge sin la firma del cliente', async () => {
    const client = Keypair.random();
    const { transaction } = await buildChallenge(client.publicKey());
    // Sin clientSign — solo la firma del servidor
    await expect(verifyChallenge(transaction)).rejects.toThrow('not signed by the claimed account');
  });

  it('rechaza XDR corrupto', async () => {
    await expect(verifyChallenge('garbage-xdr')).rejects.toThrow('Invalid transaction XDR');
  });
});
