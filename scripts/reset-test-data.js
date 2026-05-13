/**
 * reset-test-data.js
 *
 * Limpia todas las colecciones transaccionales para reiniciar los tests de FE.
 * NO toca: users, transactionconfigs, exchangerates, spaconfigs, srlconfigs,
 *          businessprofiles, contacts, sanctionslists, reclamos.
 *
 * Uso:
 *   node --env-file=.env scripts/reset-test-data.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGODB_URI);
console.log('[reset-test-data] Conectado a MongoDB\n');

const COLLECTIONS = [
  { name: 'transactions',       label: 'Transacciones'          },
  { name: 'fundingrecords',     label: 'FundingRecords (USDC)'  },
  { name: 'walletusdcs',        label: 'WalletUSDC'             },
  { name: 'walletbobs',         label: 'WalletBOB'              },
  { name: 'wallettransactions', label: 'WalletTransactions'     },
  { name: 'idempotencykeys',    label: 'IdempotencyKeys'        },
  { name: 'notifications',      label: 'Notifications'          },
];

for (const { name, label } of COLLECTIONS) {
  const col = mongoose.connection.collection(name);
  const count = await col.countDocuments();
  if (count === 0) {
    console.log(`  ⚪ ${label.padEnd(28)} 0 documentos — nada que borrar`);
    continue;
  }
  await col.deleteMany({});
  console.log(`  🗑️  ${label.padEnd(28)} ${count} documentos eliminados`);
}

console.log('\n✅ Reset completado. App lista para tests FE desde cero.');
await mongoose.disconnect();
