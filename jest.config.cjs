/** @type {import('jest').Config} */
module.exports = {
  // ESM support — requires NODE_OPTIONS=--experimental-vm-modules
  // Note: '.js' is auto-inferred from package.json "type": "module", no need to list it
  transform: {},                      // No Babel — native ESM via Node

  testEnvironment: 'node',
  testTimeout:     30_000,            // 30 s — MongoDB memory server puede ser lento

  // Test discovery
  testMatch: [
    '<rootDir>/tests/**/*.test.js',
  ],

  // Cobertura (activar con --coverage)
  collectCoverageFrom: [
    'src/controllers/**/*.js',
    'src/services/**/*.js',
    'src/middlewares/**/*.js',
    '!src/**/*.test.js',
  ],
};
