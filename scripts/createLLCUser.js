import 'dotenv/config'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import User from '../src/models/User.js'

await mongoose.connect(process.env.MONGODB_URI)

const password = await bcrypt.hash('LLCTest1234!', 10)

const user = await User.findOneAndUpdate(
  { email: 'llctest@alyto.app' },
  {
    email:          'llctest@alyto.app',
    password,
    firstName:      'Test',
    lastName:       'LLC',
    legalEntity:    'LLC',
    accountType:    'business',
    kycStatus:      'approved',
    kybStatus:      'approved',
    role:           'user',
    residenceCountry: 'US',
  },
  { upsert: true, new: true, setDefaultsOnInsert: true }
)

console.log('✅ Usuario LLC creado/actualizado:', user.email, '| legalEntity:', user.legalEntity)
await mongoose.disconnect()
