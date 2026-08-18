# Graph Report - .  (2026-08-17)

## Corpus Check
- 31 files · ~326,239 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2201 nodes · 5296 edges · 170 communities (129 shown, 41 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 465 edges (avg confidence: 0.74)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Agente Marketing y Auditoría Admin
- Facturación y Generación PDF
- Servicios de IA y Soporte
- Cotización y Pago Transfronterizo
- Rutas Admin, Reclamos y Config SRL
- Integración Vita Wallet
- AnchorAdmin Tesorería y Solvencia
- Billetera USDC y Notificaciones
- Envío de Email y Monitores ROS
- Payouts y Cifrado PII
- Control Admin de Billeteras
- Libro Mayor: Núcleo y Cierre
- Panel Admin y Corredores
- Tipos de Cambio
- Autenticación y Registro
- WebSocket de Cotizaciones
- Orquestación y Fallback de Proveedores
- BANECO Bancos y Desembolsos
- Servicio Stellar Transacciones
- Infraestructura de Tests
- Perfil de Usuario
- Migración S3 y Object Lock
- BANECO QR Cobros
- Dependencias NPM Producción
- Test E2E QR Billetera
- Config de Transacciones y Corredores
- Middleware de Autorización
- Scripts NPM
- KYB Empresarial
- Modelo Transacción y Trazas
- IPN, Payouts y Email
- SEP-24 Depósitos y Retiros
- Diagnóstico Cobertura Vita
- Fondeo de Tesorería
- Arranque del Servidor
- Verificación Config Producción
- Gestión de Secretos AWS
- Logging y Registro de Jobs
- Integración OwlPay/Harbor
- Tests IPN y Mocks Vita
- SEP-31 Pagos Interbancarios
- Admin de Cuentas Bancarias
- SEP-12 KYC Anchor
- Base de Conocimiento de Soporte
- Test KYB
- Libro Mayor: Reportes y Balanza
- Config Stellar y Comisiones
- Plantillas Email SendGrid
- Conciliación Transferencias Vita
- Libro Mayor: Sincronía con Wallet
- Test E2E Bolivia
- Test Corredor CL-BO
- Test E2E Corredor CL-BO
- Test de Reclamos
- Test de Sanciones
- Test Billetera BOB
- Inspección Esquemas Harbor
- Setup Stellar Mainnet
- KYC: Controlador y Sesiones
- Lista de Espera
- Libro Mayor: API Admin
- Sanciones y Listas
- Conciliación QR Bancario
- Tests Servicio Stellar
- Transferencia Harbor Producción
- Monitor Depósitos USDC
- Custodia de Claves Stellar
- Test Harbor
- Tests Webhook OwlPay
- Consumidor Cola SQS IPN
- Test E2E Protocolos SEP
- Guarda Sandbox y Simuladores
- Aprovisionamiento Colas SQS
- Diagnóstico CI Pendiente
- Alias de Usuario
- Simulación de Flujo
- Contactos
- Dashboard y Mapeo de Entidades
- Conciliación Transferencias Harbor
- Libro Mayor: Consolidación Multi-Moneda
- Libro Mayor: Estados Financieros
- Webhook Stripe Identity
- Metadatos package.json
- Auditoría Harbor E2E
- Proveedor OwlPay y Payout Instrument
- Validación de Enrutamiento
- SEP-10 Autenticación Stellar
- Verificación Pública de Facturas
- Test Admin Marketing
- Tests Cálculo Cotización
- Exportar Corredores PDF
- Fondeo USDC SRL
- Migración Usuarios Legacy
- API de Notificaciones
- Integración Fintoc
- CI/CD y Keep-Alive Render
- Dependencias de Desarrollo
- Actualización Claves Secretas
- Limpieza Transacciones Huérfanas
- Servidor de Tasas Vita
- Constructor de Transacciones Stellar
- Secreto AV Finance
- Identidad Visual Alyto
- Trazado AWS X-Ray
- Mocks Webhook Fintoc
- Limpieza Total Staging
- Limpieza Usuario Test Staging
- Arreglo Índice Memo USDC
- Migración USDC a Custodial
- Migración a Secrets Manager
- Borrado de Transacciones
- Modelo Usuario y Monitores
- Mapeo Errores Vita
- Script Shell Colas SQS
- Limpieza KYB Usuario Test
- Limpieza Usuario Staging
- Limpieza Transacciones Billetera
- Limpieza Transacciones Harbor
- Migración Corredores SRL OwlPay
- Migración Corredores Vita AU/CNUSD
- Reset Mongo Staging
- Registro Fondeo Staging
- Reanudar Envío USDC
- Datos Bancarios SRL
- Backfill Email Verificado
- Limpieza Txs Usuario Test
- Inspección Último Usuario
- Migración Moneda por Entidad
- Reset Usuario de Prueba
- Revertir Payin Manual
- Semilla Staging desde Producción
- Desbloqueo KYC Usuario
- On-Ramp Institucional
- Dependencia Bedrock Runtime
- Dependencia AWS KMS
- Dependencia X-Ray Core
- Dependencia X-Ray Express
- Dependencia Compression
- Dependencia CORS
- Dependencia Express
- Dependencia Rate Limit
- Dependencia JSON Web Token
- Dependencia Mongoose
- Dependencia PDFKit
- Dependencia Sentry Node
- Dependencia Sentry Profiling
- Dependencia Stripe
- Dependencia Winston
- Dependencia Winston CloudWatch
- Dependencia WebSocket ws
- Script Rol IAM
- Script Lambda Jobs
- Script Object Lock Bucket
- Script Claves Secretas
- Limpieza Staging
- Volcado de Corredores
- Migración Estado Payin Pending
- Migración Markup Vita
- Reset Datos de Prueba
- Mínimos Coherentes
- Esquema Ledger Outbox

## God Nodes (most connected - your core abstractions)
1. `User` - 140 edges
2. `err()` - 120 edges
3. `Transaction` - 52 edges
4. `logger` - 44 edges
5. `TransactionConfig` - 34 edges
6. `NOTIFICATIONS` - 32 edges
7. `notify()` - 29 edges
8. `protect()` - 28 edges
9. `scripts` - 25 edges
10. `initCrossBorderPayment()` - 23 edges

## Surprising Connections (you probably didn't know these)
- `reconcilePaidQRs()` --indirect_call--> `date()`  [INFERRED]
  src/jobs/reconcileBankQrPayments.js → scripts/full-tx-trace.js
- `screenDocument()` --indirect_call--> `err()`  [INFERRED]
  src/services/sanctionsService.js → scripts/fund-srl-usdc.js
- `sweepExpiredWalletQRs()` --indirect_call--> `wtx()`  [INFERRED]
  src/jobs/reconcileBankQrPayments.js → tests/unit/ledgerPostings.test.js
- `Catalogo SendGrid Dynamic Templates — payin manual Bolivia SRL` --semantically_similar_to--> `Catalogo SendGrid Dynamic Templates — ciclo de vida del pago`  [INFERRED] [semantically similar]
  src/templates/email/README.md → templates/email/README.md
- `Tema visual claro de emails Alyto (#F0F4F8 / #1D3461, system-ui, tarjeta 580px)` --semantically_similar_to--> `Tema visual oscuro de emails Alyto (#0F1628, Inter, tablas 600px MSO-safe)`  [INFERRED] [semantically similar]
  src/templates/email/README.md → templates/email/README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Flujo de correos del payin manual Bolivia (usuario + admin + acreditacion)** — src_templates_email_readme_sendgrid_dynamic_templates_bolivia, src_templates_email_manual_payin_manual_payin_template, src_templates_email_admin_manual_payin_admin_manual_payin_template, src_templates_email_deposit_confirmed_deposit_confirmed_template, templates_email_admin_bolivia_alert_admin_bolivia_alert_template [INFERRED 0.85]
- **Notificaciones al usuario del ciclo de vida del pago (iniciado, completado, fallido)** — templates_email_readme_sendgrid_template_catalog, templates_email_payment_initiated_payment_initiated_template, templates_email_payment_completed_payment_completed_template, templates_email_payment_failed_payment_failed_template, templates_email_readme_sendgrid_variable_contract [EXTRACTED 1.00]
- **Lazo de disponibilidad del backend de staging en Render (cron ping al health check)** — _github_workflows_keepalive_keep_alive_staging, _github_workflows_keepalive_render_cold_start_mitigation, render_alyto_backend_v2, render_health_check_endpoint [INFERRED 0.85]
- **Alyto Visual Identity System (wordmark, palette, chevron motif, lettering)** — src_assets_logoalyto_alyto_wordmark_logo, src_assets_logoalyto_brand_color_palette, src_assets_logoalyto_chevron_y_glyph, src_assets_logoalyto_lowercase_geometric_wordmark [INFERRED 0.85]

## Communities (170 total, 41 thin omitted)

### Community 0 - "Agente Marketing y Auditoría Admin"
Cohesion: 0.06
Nodes (54): getMarketingAgentSystemPrompt(), aprobar(), ERRORES_UPSTREAM, estadoModulo(), fail(), generar(), listarHistorial(), listarPendientes() (+46 more)

### Community 1 - "Facturación y Generación PDF"
Cohesion: 0.08
Nodes (53): qrcode, qrcode, adminGetBusinessInvoice(), autoGenerateBusinessInvoice(), buildInvoiceDTO(), findAndValidateTransaction(), generateAndStreamPDF(), generateBusinessInvoiceForTransaction() (+45 more)

### Community 2 - "Servicios de IA y Soporte"
Cohesion: 0.06
Nodes (45): supportChatLimiter, uploadPaymentProof(), chatSupport(), fallbackReply(), sanitizeHistory(), supportContact(), router, extractJson() (+37 more)

### Community 3 - "Cotización y Pago Transfronterizo"
Cohesion: 0.09
Nodes (42): calculateBOBQuote(), COUNTRY_META, extractVitaPricing(), FALLBACK_WITHDRAWAL_RULES, fintocWebhook(), flattenHarborSchema(), getHarborMethodsRequirements(), getPayinMethods() (+34 more)

### Community 4 - "Rutas Admin, Reclamos y Config SRL"
Cohesion: 0.09
Nodes (40): err(), adminGetReclamo(), adminListarReclamos(), adminReclamosVencimientos(), adminResponderReclamo(), crearReclamo(), getReclamo(), listarReclamos() (+32 more)

### Community 5 - "Integración Vita Wallet"
Cohesion: 0.11
Nodes (41): checkEnv(), __dirname, ENV_FILE, fail(), ok(), OUTPUT_DIR, patchEnvWalletUuid(), printSummary() (+33 more)

### Community 6 - "AnchorAdmin Tesorería y Solvencia"
Cohesion: 0.10
Nodes (37): handleAuditLog(), handleFrozenWallets(), handleListenerStatus(), handleReconciliation(), handleSolvency(), handleTreasuryStatus(), getUSDCForecast(), _adminEmail() (+29 more)

### Community 7 - "Billetera USDC y Notificaciones"
Cohesion: 0.13
Nodes (36): generateWalletQR(), previewQR(), scanAndPayQR(), adminConfirmBOBtoUSDC(), adminConfirmUSDCtoBOB(), adminListAllConversions(), adminRejectBOBtoUSDC(), adminRejectUSDCtoBOB() (+28 more)

### Community 8 - "Envío de Email y Monitores ROS"
Cohesion: 0.08
Nodes (28): mockTransaction, mockUser, TESTS, ACCOUNT_LOW_THRESHOLD, CHANNEL_LOW_THRESHOLD, _lastAlertAt, monitorChannelXLM(), _publicKeyFromSecretEnv() (+20 more)

### Community 9 - "Payouts y Cifrado PII"
Cohesion: 0.16
Nodes (29): generateSrlComprobante(), maxManualRateDeviationPct(), processBoliviaManualPayout(), resolveComprobanteRate(), checkSanctions(), isFailClosed(), SCREENING_UNAVAILABLE_RESPONSE, aadForDocumentNumber() (+21 more)

### Community 10 - "Control Admin de Billeteras"
Cohesion: 0.09
Nodes (32): adminConfirmDeposit(), adminConfirmWithdrawal(), adminDispatchWithdrawal(), adminFreezeWallet(), adminGetWithdrawalComprobante(), adminListAllWithdrawals(), adminListPendingDeposits(), adminListWallets() (+24 more)

### Community 11 - "Libro Mayor: Núcleo y Cierre"
Cohesion: 0.12
Nodes (24): args, COMMIT, lines, journalEntrySchema, ledgerAccountSchema, systemConfigSchema, assertNotInClosedPeriod(), buildClosingLines() (+16 more)

### Community 12 - "Panel Admin y Corredores"
Cohesion: 0.09
Nodes (34): CORRIDOR_PROTECTED_FIELDS, createCorridor(), currentUserField(), deactivateCorridor(), getAllUsers(), getCorridorAnalytics(), getCorridorRates(), getGlobalAnalytics() (+26 more)

### Community 13 - "Tipos de Cambio"
Cohesion: 0.14
Nodes (27): deleteBOBUSDCOverride(), getCLPBOBRate(), getPublicExchangeRate(), getPublicExchangeRates(), listExchangeRates(), updateCLPBOBRate(), upsertExchangeRate(), getUSDCRate() (+19 more)

### Community 14 - "Autenticación y Registro"
Cohesion: 0.12
Nodes (29): emailVerifyLimiter, forgotPasswordLimiter, generalLimiter, loginLimiter, makeLimiter(), paymentsLimiter, registerLimiter, resetPasswordLimiter (+21 more)

### Community 15 - "WebSocket de Cotizaciones"
Cohesion: 0.12
Nodes (29): RFC-6265, getVitaAmount(), spAConfigSchema, getHarborQuote(), CACHE_REFRESH_BEFORE_EXPIRY, computeQuote(), connectionCount(), connectionsPerUser (+21 more)

### Community 16 - "Orquestación y Fallback de Proveedores"
Cohesion: 0.10
Nodes (17): becQrProvider, execute(), getStripe(), ZERO_DECIMAL_CURRENCIES, buildBoliviaCompliancePayload(), buildPayinPayload(), buildPayoutPayload(), buildTransitPayload() (+9 more)

### Community 17 - "BANECO Bancos y Desembolsos"
Cohesion: 0.14
Nodes (25): adapters, banecoAdapter, fmtDate(), getBalance(), getEncryptedAccount(), getMovements(), isAvailable(), queryAccount() (+17 more)

### Community 18 - "Servicio Stellar Transacciones"
Cohesion: 0.14
Nodes (23): stellarBalance(), reconcileStellarTransits(), ENTITY_KEYPAIRS, execute(), healthCheck(), buildFeeBumpTransaction(), CLP_USD_FALLBACK, ensureTrustline() (+15 more)

### Community 19 - "Infraestructura de Tests"
Cohesion: 0.16
Nodes (12): createAdminUser(), createSpAUser(), createSRLUser(), clearCollections(), connectTestDb(), disconnectTestDb(), seedCorridor(), seedCorridorClCo() (+4 more)

### Community 20 - "Perfil de Usuario"
Cohesion: 0.14
Nodes (23): seedAdmin(), ALLOWED_UPDATE_FIELDS, buildProfileResponse(), changePassword(), deleteFcmToken(), getProfile(), getSessions(), processKyc() (+15 more)

### Community 21 - "Migración S3 y Object Lock"
Cohesion: 0.09
Nodes (19): DEST, destS3, DRY_RUN, existsInDest(), main(), SRC, srcS3, streamToBuffer() (+11 more)

### Community 22 - "BANECO QR Cobros"
Cohesion: 0.12
Nodes (24): amount, args, cancelAfter, cipherOnly, fmtDate(), main(), mask(), apiFetch() (+16 more)

### Community 23 - "Dependencias NPM Producción"
Cohesion: 0.07
Nodes (27): @anthropic-ai/sdk, @aws-sdk/client-s3, @aws-sdk/client-secrets-manager, @aws-sdk/client-sqs, @aws-sdk/s3-request-presigner, bcryptjs, cookie-parser, dotenv (+19 more)

### Community 24 - "Test E2E QR Billetera"
Cohesion: 0.26
Nodes (25): DEFAULT_TTL, api(), args, assert(), c, CREDS, log(), logFail() (+17 more)

### Community 25 - "Config de Transacciones y Corredores"
Cohesion: 0.12
Nodes (17): spaCLPCorridors, CORREDORES, seedCorredores(), corridors, corridors, owlPayBase, corridors, getAvailableCorridors() (+9 more)

### Community 26 - "Middleware de Autorización"
Cohesion: 0.12
Nodes (15): getMemoryStats(), resetUserTokenVersion(), clearUserCache(), getCachedUser(), invalidateUserCache(), protect(), requireAdmin(), requireEntity() (+7 more)

### Community 27 - "Scripts NPM"
Cohesion: 0.08
Nodes (25): scripts, check:env, check:production, dev, email:test, fund:srl, fund:srl:1000, fund:srl:500 (+17 more)

### Community 28 - "KYB Empresarial"
Cohesion: 0.16
Nodes (21): applyKYB(), downloadKYBDocument(), fileToBase64(), getKYBApplication(), getKYBStatus(), listKYBApplications(), reviewKYBApplication(), runKybAiAnalysis() (+13 more)

### Community 29 - "Modelo Transacción y Trazas"
Cohesion: 0.09
Nodes (18): CONFIRM, TXID, cursor, date(), dline, line, buildPayload(), run() (+10 more)

### Community 30 - "IPN, Payouts y Email"
Cohesion: 0.20
Nodes (19): appendIpnLog(), buildBeneficiaryPayloads(), COMPACT_BENEFICIARY_FIELDS, convertBobToUsdc(), dispatchPayout(), generateComprobanteOnCompletion(), handleBankQrIPN(), handleBecDisbursementIPN() (+11 more)

### Community 31 - "SEP-24 Depósitos y Retiros"
Cohesion: 0.18
Nodes (19): getKeypairInfo(), provisionKeypair(), handleDeposit(), handleGetFee(), handleGetInfo(), handleGetTransaction(), handleListTransactions(), handleWithdraw() (+11 more)

### Community 32 - "Diagnóstico Cobertura Vita"
Cohesion: 0.23
Nodes (20): analyzePrices(), analyzeVitaSentPrices(), analyzeWithdrawalRules(), buildSortedBody(), deepClean(), __dirname, EU_COUNTRIES, fail() (+12 more)

### Community 33 - "Fondeo de Tesorería"
Cohesion: 0.17
Nodes (17): calcUsdEquivalent(), cancelFundingIntent(), createFunding(), createFundingIntent(), generateFundingId(), getFundingBalance(), listFunding(), listFundingIntents() (+9 more)

### Community 34 - "Arranque del Servidor"
Cohesion: 0.13
Nodes (15): checkEnv(), CRITICAL, IMPORTANT, isMain, OPTIONAL, sentryContext(), router, allowedOrigins (+7 more)

### Community 35 - "Verificación Config Producción"
Cohesion: 0.25
Nodes (18): buildVitaSignature(), C, checkData(), checkEnvVars(), checkMongoDB(), checkSecurity(), checkSendGrid(), checkVita() (+10 more)

### Community 36 - "Gestión de Secretos AWS"
Cohesion: 0.14
Nodes (11): args, brief, DELAY_MS, failures, ENC_CONTEXT, kms, auditSecrets(), credentialMode() (+3 more)

### Community 37 - "Logging y Registro de Jobs"
Cohesion: 0.15
Nodes (11): jobNames(), JOBS, runJob(), sep10Protect(), router, devFormat, jsonFormat, logger (+3 more)

### Community 38 - "Integración OwlPay/Harbor"
Cohesion: 0.18
Nodes (18): cacheGet(), cacheSet(), getCachedRequirementsByCountry(), getHarborMethodsWithSchemas(), getHarborTransferRequirements(), getHarborTransferStatus(), getOnRampOrderStatus(), getOwlPayApiKey() (+10 more)

### Community 39 - "Tests IPN y Mocks Vita"
Cohesion: 0.13
Nodes (11): mockCreatePayout, mockGetPrices, sendVitaIPN(), buildSortedBody(), generateVitaIPNHeaders(), mockVitaPricesResponse(), sortObjectKeys(), vitaPayinSucceededIPN() (+3 more)

### Community 40 - "SEP-31 Pagos Interbancarios"
Cohesion: 0.21
Nodes (14): amount, C, Transaction, handleCreateTransaction(), handleGetInfo(), handleGetTransaction(), handlePatchTransaction(), buildSep31TransactionObject() (+6 more)

### Community 41 - "Admin de Cuentas Bancarias"
Cohesion: 0.20
Nodes (13): BALANCE_TTL_MS, _balanceCache, ensureDefaultBankAccounts(), getBankBalance(), getBankMovements(), getTreasuryCoverage(), getUserWalletSummary(), listBanks() (+5 more)

### Community 42 - "SEP-12 KYC Anchor"
Cohesion: 0.21
Nodes (15): handleDelete(), handleGet(), handlePut(), resolveOwnIdentity(), buildMissingFields(), buildProvidedFields(), deleteCustomer(), getCustomer() (+7 more)

### Community 43 - "Base de Conocimiento de Soporte"
Cohesion: 0.18
Nodes (14): walletFeeConfigSchema, _cache, COUNTRY_NAMES, EU_COUNTRIES, feeSummary(), fieldSummary(), formatCorridorKnowledge(), formatP2pKnowledge() (+6 more)

### Community 44 - "Test KYB"
Cohesion: 0.22
Nodes (15): args, assert(), cleanupTestKYB(), colors, CREDS, log(), logFail(), logInfo() (+7 more)

### Community 45 - "Libro Mayor: Reportes y Balanza"
Cohesion: 0.26
Nodes (12): args, aggregateByAccount(), buildOpeningBalanceLines(), captureWalletSnapshot(), CONTROL_ACCOUNTS, R7(), reconcileControlAccounts(), trialBalance() (+4 more)

### Community 46 - "Config Stellar y Comisiones"
Cohesion: 0.18
Nodes (13): ASSETS, BASE_FEE_STROOPS, horizonServer, NETWORK_INFO, NETWORK_PASSPHRASE, SEP10_SIGNING_PUBLIC, TX_TIMEOUT_SECONDS, renderStellarToml() (+5 more)

### Community 47 - "Plantillas Email SendGrid"
Cohesion: 0.32
Nodes (16): Template email admin: nuevo pago manual pendiente de verificar, Template email: deposito BOB acreditado en billetera, Template email: instrucciones de transferencia bancaria AV Finance SRL, Codigo de referencia obligatorio en el concepto de la transferencia, adminManualPayinAlert definido pero no llamado — fallback a adminBoliviaAlert, Tema visual claro de emails Alyto (#F0F4F8 / #1D3461, system-ui, tarjeta 580px), Catalogo SendGrid Dynamic Templates — payin manual Bolivia SRL, Template email admin: payout manual requerido corredor anchorBolivia (+8 more)

### Community 48 - "Conciliación Transferencias Vita"
Cohesion: 0.22
Nodes (13): APPLY, args, main(), PROD, recordSent(), alertAdminUnresolved(), finalizeVitaCompleted(), finalizeVitaFailed() (+5 more)

### Community 49 - "Libro Mayor: Sincronía con Wallet"
Cohesion: 0.30
Nodes (12): COMMIT, accountsFor(), buildBobToUsdcEntry(), buildUsdcToBobEntry(), buildWalletTxEntry(), classifyWalletTx(), entryBase(), R7() (+4 more)

### Community 50 - "Test E2E Bolivia"
Cohesion: 0.23
Nodes (14): args, assert(), colors, CREDS, log(), logFail(), logInfo(), logOk() (+6 more)

### Community 51 - "Test Corredor CL-BO"
Cohesion: 0.23
Nodes (14): args, assert(), colors, CREDS, log(), logFail(), logInfo(), logOk() (+6 more)

### Community 52 - "Test E2E Corredor CL-BO"
Cohesion: 0.23
Nodes (14): args, assert(), c, CREDS, log(), logFail(), logInfo(), logOk() (+6 more)

### Community 53 - "Test de Reclamos"
Cohesion: 0.23
Nodes (14): args, assert(), colors, CREDS, log(), logFail(), logInfo(), logOk() (+6 more)

### Community 54 - "Test de Sanciones"
Cohesion: 0.23
Nodes (14): args, assert(), colors, CREDS, log(), logFail(), logInfo(), logOk() (+6 more)

### Community 55 - "Test Billetera BOB"
Cohesion: 0.24
Nodes (14): args, assert(), colors, CREDS, log(), logFail(), logInfo(), logOk() (+6 more)

### Community 56 - "Inspección Esquemas Harbor"
Cohesion: 0.18
Nodes (8): beneficiary_info, CUSTOMER_UUID, payout_instrument, allResults, COUNTRIES, schemaStr, createQuote(), getRequirementsSchema()

### Community 57 - "Setup Stellar Mainnet"
Cohesion: 0.36
Nodes (13): ACCOUNTS, banner(), getAccountSafe(), getUSDCBalance(), getXLMBalance(), hasTrustline(), modeCheck(), modeGenerate() (+5 more)

### Community 58 - "KYC: Controlador y Sesiones"
Cohesion: 0.24
Nodes (11): kycSessionLimiter, approveKycTest(), createKycSession(), getKycDebug(), getKycStatus(), getStripe(), HARD_REJECTION_CODES, runSanctionsScreening() (+3 more)

### Community 59 - "Lista de Espera"
Cohesion: 0.23
Nodes (10): waitlistLimiter, clean(), csvCell(), exportCsv(), listEntries(), subscribe(), waitlistEntrySchema, router (+2 more)

### Community 60 - "Libro Mayor: API Admin"
Cohesion: 0.36
Nodes (12): fail(), handleBalanceSheet(), handleClosedThrough(), handleClosePeriod(), handleConsolidated(), handleIncomeStatement(), handleReconciliation(), handleReverseEntry() (+4 more)

### Community 61 - "Sanciones y Listas"
Cohesion: 0.19
Nodes (11): addSanction(), clearSanctionsFlag(), listFlaggedUsers(), listSanctions(), removeSanction(), screenUserManual(), sanctionsListSchema, escapeRegex() (+3 more)

### Community 62 - "Conciliación QR Bancario"
Cohesion: 0.36
Nodes (12): confirmBankQrDeposit(), failExpiredBankQrDeposit(), confirmBankQrTx(), failExpiredBankQrTx(), reconcileBankQrPayments(), reconcilePaidQRs(), sweepExpiredQRs(), sweepExpiredWalletQRs() (+4 more)

### Community 63 - "Tests Servicio Stellar"
Cohesion: 0.14
Nodes (6): Asset, mockFetchBaseFee, MockHorizonServer, mockLoadAccount, mockSubmitTransaction, mockTransactionsCall

### Community 64 - "Transferencia Harbor Producción"
Cohesion: 0.15
Nodes (11): account, amount, args, bankName, baseUrl, beneficiary, CONFIRM, customerUuid (+3 more)

### Community 65 - "Monitor Depósitos USDC"
Cohesion: 0.19
Nodes (8): cursorKeyFor(), HEARTBEAT_KEY, monitorUSDCDeposits(), _pollAddress(), _processPayment(), walletTransactionSchema, walletUSDCSchema, detectIncomingUSDC()

### Community 66 - "Custodia de Claves Stellar"
Cohesion: 0.32
Nodes (12): createUsdcTrustline(), decryptSecretKey(), encryptSecretKey(), fallbackDecrypt(), fallbackEncrypt(), fundUserAccount(), getFallbackKey(), getKmsClient() (+4 more)

### Community 67 - "Test Harbor"
Cohesion: 0.38
Nodes (12): assert(), colors, HARBOR_BASE, harborRequest(), log(), logFail(), logInfo(), logOk() (+4 more)

### Community 68 - "Tests Webhook OwlPay"
Cohesion: 0.17
Nodes (8): generateOwlPayWebhookHeaders(), mockCreatePayout, mockCreateQuote, mockCreateTransfer, mockGetRequirements, mockGetStellarBalance, mockSendUSDCToHarbor, sendOwlPayWebhook()

### Community 69 - "Consumidor Cola SQS IPN"
Cohesion: 0.30
Nodes (10): HANDLERS, makeFakeRes(), startIpnConsumerJob(), enqueueIpnEvent(), getClient(), isSqsEnabled(), pollLoop(), QUEUE_URLS (+2 more)

### Community 70 - "Test E2E Protocolos SEP"
Cohesion: 0.35
Nodes (10): C, http(), record(), results, testSep1(), testSep10(), testSep12(), testSep24() (+2 more)

### Community 71 - "Guarda Sandbox y Simuladores"
Cohesion: 0.27
Nodes (6): simulateBankQrPayment(), areSimulatorsAllowed(), DENIED_BODY, denyIfProduction(), sandboxOnly(), SNAPSHOT

### Community 72 - "Aprovisionamiento Colas SQS"
Cohesion: 0.27
Nodes (8): DRY_RUN, ensureQueue(), getArn(), getUrl(), main(), MAX_RECEIVE, QUEUES, sqs

### Community 73 - "Diagnóstico CI Pendiente"
Cohesion: 0.20
Nodes (8): afectados, conCiReal, conMovimientos, conNit, fechas, ids, porEntidad, porEstado

### Community 74 - "Alias de Usuario"
Cohesion: 0.31
Nodes (6): checkAliasAvailable(), getMyAlias(), normalizeAlias(), RESERVED, setAlias(), validateAlias()

### Community 75 - "Simulación de Flujo"
Cohesion: 0.33
Nodes (9): createMockRequest(), createMockResponse(), __dirname, logState(), printBanner(), printSection(), runSimulation(), stateHistory (+1 more)

### Community 76 - "Contactos"
Cohesion: 0.31
Nodes (7): createContact(), deleteContact(), listContacts(), toggleFavorite(), updateContact(), contactSchema, router

### Community 77 - "Dashboard y Mapeo de Entidades"
Cohesion: 0.27
Nodes (7): ACTIVE_STATUSES, buildBeneficiaryName(), getDashboard(), router, ENTITY_COUNTRY_MAP, ENTITY_CURRENCY_MAP, getDefaultCurrency()

### Community 78 - "Conciliación Transferencias Harbor"
Cohesion: 0.33
Nodes (8): buildOwlPayBeneficiary(), notifyTransactionCompleted(), notifyTransactionFailed(), tryOwlPayV2(), HARBOR_TO_ALYTO_STATUS, reconcileHarborTransfers(), getTransferStatus(), mapHarborError()

### Community 79 - "Libro Mayor: Consolidación Multi-Moneda"
Cohesion: 0.33
Nodes (7): journalLineSchema, getBOBUSDCRate(), consolidate(), consolidatedBalanceSheet(), getUsdPerUnit(), R2(), RATES

### Community 80 - "Libro Mayor: Estados Financieros"
Cohesion: 0.49
Nodes (8): getAccountDef(), balanceSheet(), entryIndex(), groupBalanceSheet(), incomeStatement(), R7(), runningBalance(), treasuryStatement()

### Community 81 - "Webhook Stripe Identity"
Cohesion: 0.42
Nodes (9): _approveKyc(), _findUserForSession(), getStripe(), handleStripeWebhook(), HARD_REJECTION_CODES, _persistVerifiedOutputs(), _recoverKyc(), _rejectKyc() (+1 more)

### Community 82 - "Metadatos package.json"
Cohesion: 0.22
Nodes (8): author, description, keywords, license, main, name, type, version

### Community 83 - "Auditoría Harbor E2E"
Cohesion: 0.22
Nodes (7): CUSTOMER_UUID, results, TEST_CASES, CUSTOMER_UUID, payload, wireQuote, createTransfer()

### Community 84 - "Proveedor OwlPay y Payout Instrument"
Cohesion: 0.25
Nodes (6): beneficiary_info, fakeBeneficiary, payout_instrument, execute(), buildPayoutInstrument(), createHarborTransfer()

### Community 85 - "Validación de Enrutamiento"
Cohesion: 0.22
Nodes (7): HARBOR_BASE, harborWins, mismatches, results, unknowns, vitaWins, getOwlPayBaseUrl()

### Community 86 - "SEP-10 Autenticación Stellar"
Cohesion: 0.44
Nodes (7): PRIORITY_FEE_STROOPS, getChallenge(), postVerify(), buildChallenge(), resolveWebAuthDomain(), sep10SigningKeypair(), verifyChallenge()

### Community 87 - "Verificación Pública de Facturas"
Cohesion: 0.36
Nodes (7): esc(), formatDate(), formatMoney(), page(), STATUS_LABELS, verifyInvoice(), router

### Community 88 - "Test Admin Marketing"
Cohesion: 0.22
Nodes (5): ADMIN, app, completeMock, OTRO_ADMIN, USUARIO

### Community 89 - "Tests Cálculo Cotización"
Cohesion: 0.25
Nodes (4): completeMock, baseCorridor, calculateQuote(), round2()

### Community 90 - "Exportar Corredores PDF"
Cohesion: 0.25
Nodes (7): col, countryArg, doc, groups, ORDER, PROVIDER_LABEL, providers

### Community 91 - "Fondeo USDC SRL"
Cohesion: 0.39
Nodes (7): colors, errors, getUSDCBalance(), info(), main(), ok(), warn()

### Community 92 - "Migración Usuarios Legacy"
Cohesion: 0.36
Nodes (7): buildKycDocuments(), COUNTRY_TO_ENTITY, ENTITY_DEFAULT_DOC_TYPE, KYC_STATUS_MAP, migrate(), resolveEntity(), resolveKycStatus()

### Community 93 - "API de Notificaciones"
Cohesion: 0.36
Nodes (5): getNotifications(), getUnreadCount(), markAsRead(), notificationSchema, router

### Community 94 - "Integración Fintoc"
Cohesion: 0.39
Nodes (5): initiateFintocPayin(), execute(), createWidgetLink(), fintocRequest(), getPaymentIntent()

### Community 95 - "CI/CD y Keep-Alive Render"
Cohesion: 0.43
Nodes (7): Workflow keep-alive staging (GitHub Actions), Mitigacion de cold start por spin-down en Render, Paridad de runtime Node 22 entre CI y Dockerfile (node:22-slim), Suite Jest autocontenida (mongodb-memory-server, mocks de proveedores, supertest, sin secretos), Workflow CI Tests (gate Jest en push/PR a main), Servicio web Render alyto-backend-v2 (plan starter, node src/server.js), Health check /api/v1/health

### Community 96 - "Dependencias de Desarrollo"
Cohesion: 0.29
Nodes (7): jest, mongodb-memory-server, devDependencies, jest, mongodb-memory-server, supertest, supertest

### Community 97 - "Actualización Claves Secretas"
Cohesion: 0.29
Nodes (5): delKeys, DRY_RUN, pairs, rawArgs, setOps

### Community 98 - "Limpieza Transacciones Huérfanas"
Cohesion: 0.29
Nodes (6): CONFIRM, ids, keep, KEEP_STATUS, orphans, userIds

### Community 99 - "Servidor de Tasas Vita"
Cohesion: 0.29
Nodes (4): __dirname, PAISES, PORT, server

### Community 101 - "Secreto AV Finance"
Cohesion: 0.33
Nodes (5): client, current, DRY_RUN, merged, UPDATES

### Community 102 - "Identidad Visual Alyto"
Cohesion: 0.53
Nodes (6): Alyto Product Brand Identity, Alyto Wordmark Logo (LogoAlyto.png), Alyto Brand Color Palette (navy #23405C + yellow #F5D216), Chevron 'y' Glyph Motif, Lowercase Geometric Sans Wordmark Treatment, Brand Asset Usage in PDF Comprobantes (AV_FINANCE_LOGO_PATH)

### Community 103 - "Trazado AWS X-Ray"
Cohesion: 0.60
Nodes (5): isXrayEnabled(), load(), require, xrayCloseSegment(), xrayOpenSegment()

### Community 105 - "Limpieza Total Staging"
Cohesion: 0.40
Nodes (4): CONFIRM, DELETE, RESET_WALLETS, URI

### Community 106 - "Limpieza Usuario Test Staging"
Cohesion: 0.40
Nodes (4): CONFIRM, DELETE_COLLS, filter, WALLET_RESETS

### Community 107 - "Arreglo Índice Memo USDC"
Cohesion: 0.40
Nodes (4): coll, CONFIRM, hasAddr, hasOld

### Community 108 - "Migración USDC a Custodial"
Cohesion: 0.40
Nodes (4): CONFIRM, noCustody, pending, toUpdate

### Community 109 - "Migración a Secrets Manager"
Cohesion: 0.40
Nodes (3): DRY_RUN, FORCE_UPDATE, SECRETS_TO_MIGRATE

### Community 110 - "Borrado de Transacciones"
Cohesion: 0.40
Nodes (3): EXECUTE, ONLY_CONTACTS, ONLY_TX

### Community 111 - "Modelo Usuario y Monitores"
Cohesion: 0.50
Nodes (4): getNotificationTypes(), NOTIFICATION_SCHEMAS, sendNotification(), VALID_NOTIFICATION_TYPES

### Community 112 - "Mapeo Errores Vita"
Cohesion: 0.60
Nodes (4): extractVitaData(), FIELD_LABELS_ES, fieldLabel(), mapVitaError()

### Community 115 - "Limpieza KYB Usuario Test"
Cohesion: 0.50
Nodes (3): COLLS, CONFIRM, filter

### Community 116 - "Limpieza Usuario Staging"
Cohesion: 0.50
Nodes (3): CONFIRM, KEEP_BAL, q

### Community 117 - "Limpieza Transacciones Billetera"
Cohesion: 0.50
Nodes (3): CONFIRM, DELETE_COLLECTIONS, RESET_WALLETS

### Community 118 - "Limpieza Transacciones Harbor"
Cohesion: 0.50
Nodes (3): col, DRY_RUN, query

### Community 119 - "Migración Corredores SRL OwlPay"
Cohesion: 0.83
Nodes (3): ACTIVE_IDS, INACTIVE_BUCKETS, run()

### Community 121 - "Reset Mongo Staging"
Cohesion: 0.50
Nodes (3): activeOwlPay, duplicates, WIPE_COLLECTIONS

### Community 122 - "Registro Fondeo Staging"
Cohesion: 0.50
Nodes (3): CONFIRM, doc, URI

### Community 123 - "Reanudar Envío USDC"
Cohesion: 0.50
Nodes (3): args, query, stats

### Community 124 - "Datos Bancarios SRL"
Cohesion: 0.50
Nodes (3): bankData, CONFIRM, missing

## Knowledge Gaps
- **552 isolated node(s):** `name`, `version`, `description`, `main`, `type` (+547 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **41 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `User` connect `Perfil de Usuario` to `Facturación y Generación PDF`, `Servicios de IA y Soporte`, `Cotización y Pago Transfronterizo`, `Rutas Admin, Reclamos y Config SRL`, `On-Ramp Institucional`, `AnchorAdmin Tesorería y Solvencia`, `Billetera USDC y Notificaciones`, `Envío de Email y Monitores ROS`, `Payouts y Cifrado PII`, `Control Admin de Billeteras`, `Panel Admin y Corredores`, `Autenticación y Registro`, `WebSocket de Cotizaciones`, `Servicio Stellar Transacciones`, `Infraestructura de Tests`, `Middleware de Autorización`, `KYB Empresarial`, `IPN, Payouts y Email`, `SEP-24 Depósitos y Retiros`, `Fondeo de Tesorería`, `Arranque del Servidor`, `Logging y Registro de Jobs`, `SEP-12 KYC Anchor`, `Test KYB`, `Config Stellar y Comisiones`, `Conciliación Transferencias Vita`, `KYC: Controlador y Sesiones`, `Sanciones y Listas`, `Conciliación QR Bancario`, `Custodia de Claves Stellar`, `Alias de Usuario`, `Simulación de Flujo`, `Conciliación Transferencias Harbor`, `Webhook Stripe Identity`, `SEP-10 Autenticación Stellar`, `Integración Fintoc`, `Modelo Usuario y Monitores`?**
  _High betweenness centrality (0.080) - this node is a cross-community bridge._
- **Why does `logger` connect `Logging y Registro de Jobs` to `Agente Marketing y Auditoría Admin`, `Servicios de IA y Soporte`, `Cotización y Pago Transfronterizo`, `AnchorAdmin Tesorería y Solvencia`, `Billetera USDC y Notificaciones`, `Payouts y Cifrado PII`, `Libro Mayor: Núcleo y Cierre`, `BANECO Bancos y Desembolsos`, `BANECO QR Cobros`, `IPN, Payouts y Email`, `SEP-24 Depósitos y Retiros`, `Arranque del Servidor`, `SEP-31 Pagos Interbancarios`, `Admin de Cuentas Bancarias`, `SEP-12 KYC Anchor`, `Base de Conocimiento de Soporte`, `Config Stellar y Comisiones`, `Conciliación Transferencias Vita`, `Libro Mayor: Sincronía con Wallet`, `Lista de Espera`, `Libro Mayor: API Admin`, `Conciliación QR Bancario`, `Custodia de Claves Stellar`, `Consumidor Cola SQS IPN`, `Guarda Sandbox y Simuladores`, `SEP-10 Autenticación Stellar`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **Why does `qrcode` connect `Facturación y Generación PDF` to `Fondeo de Tesorería`, `Cotización y Pago Transfronterizo`, `Dependencias NPM Producción`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **Are the 118 inferred relationships involving `err()` (e.g. with `checkAliasAvailable()` and `getMyAlias()`) actually correct?**
  _`err()` has 118 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _552 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Agente Marketing y Auditoría Admin` be split into smaller, more focused modules?**
  _Cohesion score 0.05698778833107191 - nodes in this community are weakly interconnected._
- **Should `Facturación y Generación PDF` be split into smaller, more focused modules?**
  _Cohesion score 0.08361581920903954 - nodes in this community are weakly interconnected._