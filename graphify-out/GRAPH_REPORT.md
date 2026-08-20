# Graph Report - alyto-backend-v2  (2026-08-19)

## Corpus Check
- 343 files · ~330,251 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2212 nodes · 5509 edges · 168 communities (128 shown, 40 thin omitted)
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 563 edges (avg confidence: 0.75)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3780cfc2`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- riskClassifier.js
- payoutController.js
- llmProvider.js
- paymentController.js
- sendEmail
- vitaWalletService.js
- anchorAdminService.js
- NOTIFICATIONS
- err
- piiCrypto.js
- vitaSandboxTest.js
- ledgerAdminController.js
- adminRoutes.js
- exchangeRateService.js
- authController.js
- quoteSocket.js
- Orquestación y Fallback de Proveedores
- bankAdminController.js
- stellarService.js
- db.js
- userController.js
- Migración S3 y Object Lock
- BANECO QR Cobros
- dependencies
- Test E2E QR Billetera
- marketingAgentService.js
- authMiddleware.js
- Scripts NPM
- kybController.js
- Transaction.js
- ipnController.js
- sep24Service.js
- Diagnóstico Cobertura Vita
- fundingController.js
- server.js
- checkProduction.js
- awsSecrets.js
- logger.js
- owlPayService.js
- fullPaymentFlow.test.js
- sep31Service.js
- marketingAgentController.js
- sep12Service.js
- supportAgentService.js
- Test KYB
- stellarRoutes.js
- stellar.js
- Plantillas Email SendGrid
- @aws-sdk/client-kms
- kybAnalysisService.js
- Test E2E Bolivia
- Test Corredor CL-BO
- Test E2E Corredor CL-BO
- Test de Reclamos
- Test de Sanciones
- Test Billetera BOB
- createQuote
- Setup Stellar Mainnet
- kycController.js
- waitlistRoutes.js
- marketingCampaignService.js
- adminAuditService.js
- reconcileBankQrPayments.js
- Tests Servicio Stellar
- harbor-prod-test-transfer.mjs
- email.js
- custodyService.js
- Test Harbor
- ipn.test.js
- TransactionConfig
- test-sep-e2e.mjs
- environmentGuards.test.js
- Aprovisionamiento Colas SQS
- Diagnóstico CI Pendiente
- User
- Simulación de Flujo
- Contactos
- WalletUSDC.js
- monitorChannelXLM.js
- euAmountRouter.js
- notificationRoutes.js
- stripeWebhook.js
- Metadatos package.json
- supportKnowledge.js
- backfill-withdrawal-audit-trail.mjs
- SRLConfig
- BoundedCache
- Verificación Pública de Facturas
- Test Admin Marketing
- setup.env.js
- Exportar Corredores PDF
- Fondeo USDC SRL
- Migración Usuarios Legacy
- validate-routing.js
- audit-harbor-end-to-end.js
- CI/CD y Keep-Alive Render
- Dependencias de Desarrollo
- Actualización Claves Secretas
- Limpieza Transacciones Huérfanas
- Servidor de Tasas Vita
- sep10Service.js
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
- getCustomerUuid
- checkEnv.js
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
- Dependencia Bedrock Runtime
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
1. `err()` - 155 edges
2. `User` - 135 edges
3. `NOTIFICATIONS` - 51 edges
4. `notify()` - 50 edges
5. `TransactionConfig` - 45 edges
6. `logger` - 44 edges
7. `dispatchPayout()` - 36 edges
8. `sendEmail()` - 32 edges
9. `protect()` - 28 edges
10. `sendRawEmail()` - 27 edges

## Surprising Connections (you probably didn't know these)
- `reconcilePaidQRs()` --indirect_call--> `date()`  [INFERRED]
  src/jobs/reconcileBankQrPayments.js → scripts/full-tx-trace.js
- `screenDocument()` --indirect_call--> `err()`  [INFERRED]
  src/services/sanctionsService.js → scripts/fund-srl-usdc.js
- `Catalogo SendGrid Dynamic Templates — payin manual Bolivia SRL` --semantically_similar_to--> `Catalogo SendGrid Dynamic Templates — ciclo de vida del pago`  [INFERRED] [semantically similar]
  src/templates/email/README.md → templates/email/README.md
- `Tema visual claro de emails Alyto (#F0F4F8 / #1D3461, system-ui, tarjeta 580px)` --semantically_similar_to--> `Tema visual oscuro de emails Alyto (#0F1628, Inter, tablas 600px MSO-safe)`  [INFERRED] [semantically similar]
  src/templates/email/README.md → templates/email/README.md
- `Template email: instrucciones de transferencia bancaria AV Finance SRL` --semantically_similar_to--> `Template email: pago iniciado / en camino`  [INFERRED] [semantically similar]
  src/templates/email/manual_payin.html → templates/email/payment-initiated.html

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Flujo de correos del payin manual Bolivia (usuario + admin + acreditacion)** — src_templates_email_readme_sendgrid_dynamic_templates_bolivia, src_templates_email_manual_payin_manual_payin_template, src_templates_email_admin_manual_payin_admin_manual_payin_template, src_templates_email_deposit_confirmed_deposit_confirmed_template, templates_email_admin_bolivia_alert_admin_bolivia_alert_template [INFERRED 0.85]
- **Notificaciones al usuario del ciclo de vida del pago (iniciado, completado, fallido)** — templates_email_readme_sendgrid_template_catalog, templates_email_payment_initiated_payment_initiated_template, templates_email_payment_completed_payment_completed_template, templates_email_payment_failed_payment_failed_template, templates_email_readme_sendgrid_variable_contract [EXTRACTED 1.00]
- **Lazo de disponibilidad del backend de staging en Render (cron ping al health check)** — _github_workflows_keepalive_keep_alive_staging, _github_workflows_keepalive_render_cold_start_mitigation, render_alyto_backend_v2, render_health_check_endpoint [INFERRED 0.85]
- **Alyto Visual Identity System (wordmark, palette, chevron motif, lettering)** — src_assets_logoalyto_alyto_wordmark_logo, src_assets_logoalyto_brand_color_palette, src_assets_logoalyto_chevron_y_glyph, src_assets_logoalyto_lowercase_geometric_wordmark [INFERRED 0.85]

## Communities (168 total, 40 thin omitted)

### Community 0 - "riskClassifier.js"
Cohesion: 0.11
Nodes (20): clasificarRiesgo(), coincidenciasDe(), MOTIVOS, normalizar(), RE_CIFRAS, RE_COSTO_CERO, RE_LEGAL, RE_MARCA (+12 more)

### Community 1 - "payoutController.js"
Cohesion: 0.08
Nodes (59): qrcode, qrcode, adminGetBusinessInvoice(), autoGenerateBusinessInvoice(), buildInvoiceDTO(), findAndValidateTransaction(), generateAndStreamPDF(), generateBusinessInvoiceForTransaction() (+51 more)

### Community 2 - "llmProvider.js"
Cohesion: 0.23
Nodes (13): extractJson(), imageMediaType(), isBedrockEnabled(), MAX_TOKENS, parseComprobante(), BEDROCK_IMAGE_FORMAT, complete(), completeAnthropic() (+5 more)

### Community 3 - "paymentController.js"
Cohesion: 0.06
Nodes (39): COUNTRY_META, FALLBACK_WITHDRAWAL_RULES, fintocWebhook(), flattenHarborSchema(), getPayinMethods(), getSRLPayinInstructions(), getTransactionAudit(), getTransactionHistory() (+31 more)

### Community 4 - "sendEmail"
Cohesion: 0.13
Nodes (19): adminGetReclamo(), adminListarReclamos(), adminReclamosVencimientos(), adminResponderReclamo(), crearReclamo(), getReclamo(), listarReclamos(), subirDocumentosReclamo() (+11 more)

### Community 5 - "vitaWalletService.js"
Cohesion: 0.15
Nodes (24): normalizeAsset(), vitaDiagnostic(), execute(), healthCheck(), router, buildSortedBody(), createPayin(), createPayout() (+16 more)

### Community 6 - "anchorAdminService.js"
Cohesion: 0.11
Nodes (36): handleAuditLog(), handleFrozenWallets(), handleListenerStatus(), handleReconciliation(), handleSolvency(), handleTreasuryStatus(), getUSDCForecast(), _adminEmail() (+28 more)

### Community 7 - "NOTIFICATIONS"
Cohesion: 0.11
Nodes (41): simulateBankQrPayment(), updateTransactionStatus(), deleteAccount(), uploadPaymentProof(), previewQR(), scanAndPayQR(), adminFreezeWallet(), adminUnfreezeWallet() (+33 more)

### Community 8 - "err"
Cohesion: 0.12
Nodes (34): err(), generateWalletQR(), adminAttachWithdrawalComprobante(), adminConfirmDeposit(), adminConfirmWithdrawal(), adminGetDepositComprobante(), adminGetWithdrawalComprobante(), adminListAllWithdrawals() (+26 more)

### Community 9 - "piiCrypto.js"
Cohesion: 0.18
Nodes (25): checkSanctions(), isFailClosed(), SCREENING_UNAVAILABLE_RESPONSE, aadForDocumentNumber(), awsRegion(), decryptField(), dekOrThrow(), encryptField() (+17 more)

### Community 10 - "vitaSandboxTest.js"
Cohesion: 0.23
Nodes (21): checkEnv(), __dirname, ENV_FILE, fail(), ok(), OUTPUT_DIR, patchEnvWalletUuid(), printSummary() (+13 more)

### Community 11 - "ledgerAdminController.js"
Cohesion: 0.06
Nodes (74): args, COMMIT, lines, COMMIT, args, fail(), handleBalanceSheet(), handleClosedThrough() (+66 more)

### Community 12 - "adminRoutes.js"
Cohesion: 0.08
Nodes (37): CORRIDOR_PROTECTED_FIELDS, currentUserField(), FORCED_TERMINAL_STATUSES, getAllUsers(), getCorridorRates(), getGlobalAnalytics(), getGlobalLedger(), getLedgerCounts() (+29 more)

### Community 13 - "exchangeRateService.js"
Cohesion: 0.14
Nodes (25): CORREDORES, seedCorredores(), deleteBOBUSDCOverride(), getCLPBOBRate(), getPublicExchangeRate(), getPublicExchangeRates(), listExchangeRates(), updateCLPBOBRate() (+17 more)

### Community 14 - "authController.js"
Cohesion: 0.12
Nodes (29): emailVerifyLimiter, forgotPasswordLimiter, loginLimiter, makeLimiter(), paymentsLimiter, registerLimiter, resetPasswordLimiter, skip() (+21 more)

### Community 15 - "quoteSocket.js"
Cohesion: 0.11
Nodes (37): RFC-6265, getVitaAmount(), calculateBOBQuote(), extractVitaPricing(), getQuote(), initCrossBorderPayment(), spAConfigSchema, resolveMinAmountOrigin() (+29 more)

### Community 16 - "Orquestación y Fallback de Proveedores"
Cohesion: 0.10
Nodes (17): becQrProvider, execute(), getStripe(), ZERO_DECIMAL_CURRENCIES, buildBoliviaCompliancePayload(), buildPayinPayload(), buildPayoutPayload(), buildTransitPayload() (+9 more)

### Community 17 - "bankAdminController.js"
Cohesion: 0.08
Nodes (38): BALANCE_TTL_MS, _balanceCache, ensureDefaultBankAccounts(), getBankBalance(), getBankMovements(), getTreasuryCoverage(), getUserWalletSummary(), listBanks() (+30 more)

### Community 18 - "stellarService.js"
Cohesion: 0.16
Nodes (20): error(), buildFeeBumpTransaction(), buildInnerTransaction(), CLP_USD_FALLBACK, ensureTrustline(), executeStellarPayment(), executeWeb3Transit(), _findTransactionByMemo() (+12 more)

### Community 19 - "db.js"
Cohesion: 0.17
Nodes (11): createAdminUser(), createSpAUser(), createSRLUser(), clearCollections(), connectTestDb(), disconnectTestDb(), seedCorridor(), seedCorridorClCo() (+3 more)

### Community 20 - "userController.js"
Cohesion: 0.20
Nodes (16): ALLOWED_UPDATE_FIELDS, buildProfileResponse(), changePassword(), deleteFcmToken(), getProfile(), getSessions(), processKyc(), sendProfile() (+8 more)

### Community 21 - "Migración S3 y Object Lock"
Cohesion: 0.09
Nodes (19): DEST, destS3, DRY_RUN, existsInDest(), main(), SRC, srcS3, streamToBuffer() (+11 more)

### Community 22 - "BANECO QR Cobros"
Cohesion: 0.12
Nodes (24): amount, args, cancelAfter, cipherOnly, fmtDate(), main(), mask(), apiFetch() (+16 more)

### Community 23 - "dependencies"
Cohesion: 0.07
Nodes (27): @anthropic-ai/sdk, @aws-sdk/client-s3, @aws-sdk/client-secrets-manager, @aws-sdk/client-sqs, @aws-sdk/s3-request-presigner, bcryptjs, cookie-parser, dotenv (+19 more)

### Community 24 - "Test E2E QR Billetera"
Cohesion: 0.26
Nodes (25): DEFAULT_TTL, api(), args, assert(), c, CREDS, log(), logFail() (+17 more)

### Community 25 - "marketingAgentService.js"
Cohesion: 0.22
Nodes (12): getMarketingAgentSystemPrompt(), contentPieceSchema, CAMPOS, CANALES, cfg(), generarContenido(), isMarketingAgentEnabled(), normalizar() (+4 more)

### Community 26 - "authMiddleware.js"
Cohesion: 0.16
Nodes (14): kycSessionLimiter, getCachedUser(), protect(), requireAdmin(), requireEmailVerified(), requireEntity(), setCachedUser(), userCache (+6 more)

### Community 27 - "Scripts NPM"
Cohesion: 0.08
Nodes (25): scripts, check:env, check:production, dev, email:test, fund:srl, fund:srl:1000, fund:srl:500 (+17 more)

### Community 28 - "kybController.js"
Cohesion: 0.19
Nodes (17): mockTransaction, mockUser, TESTS, applyKYB(), downloadKYBDocument(), fileToBase64(), getKYBApplication(), getKYBStatus() (+9 more)

### Community 29 - "Transaction.js"
Cohesion: 0.10
Nodes (18): cursor, date(), dline, line, buildPayload(), run(), reconcileStellarTransits(), bancarizacionSchema (+10 more)

### Community 30 - "ipnController.js"
Cohesion: 0.08
Nodes (49): CONFIRM, TXID, recordSent(), appendIpnLog(), buildBeneficiaryPayloads(), buildOwlPayBeneficiary(), COMPACT_BENEFICIARY_FIELDS, convertBobToUsdc() (+41 more)

### Community 31 - "sep24Service.js"
Cohesion: 0.24
Nodes (15): handleDeposit(), handleGetFee(), handleGetInfo(), handleGetTransaction(), handleListTransactions(), handleWithdraw(), buildSep24TransactionObject(), getAnchorInfo() (+7 more)

### Community 32 - "Diagnóstico Cobertura Vita"
Cohesion: 0.23
Nodes (20): analyzePrices(), analyzeVitaSentPrices(), analyzeWithdrawalRules(), buildSortedBody(), deepClean(), __dirname, EU_COUNTRIES, fail() (+12 more)

### Community 33 - "fundingController.js"
Cohesion: 0.18
Nodes (16): calcUsdEquivalent(), cancelFundingIntent(), createFunding(), createFundingIntent(), generateFundingId(), getFundingBalance(), listFunding(), listFundingIntents() (+8 more)

### Community 34 - "server.js"
Cohesion: 0.21
Nodes (10): cleanupOrphanTransactions(), cleanupOrphanWalletDeposits(), allowedOrigins, ANCHOR_CORS_BASE, app, dropLegacyIndexes(), resolveMongoUri(), seedDevUser() (+2 more)

### Community 35 - "checkProduction.js"
Cohesion: 0.25
Nodes (18): buildVitaSignature(), C, checkData(), checkEnvVars(), checkMongoDB(), checkSecurity(), checkSendGrid(), checkVita() (+10 more)

### Community 36 - "awsSecrets.js"
Cohesion: 0.14
Nodes (11): args, brief, DELAY_MS, failures, ENC_CONTEXT, kms, auditSecrets(), credentialMode() (+3 more)

### Community 37 - "logger.js"
Cohesion: 0.16
Nodes (10): jobNames(), JOBS, runJob(), router, devFormat, jsonFormat, logger, patchConsole() (+2 more)

### Community 38 - "owlPayService.js"
Cohesion: 0.17
Nodes (19): initiateCorporateOnRamp(), cacheGet(), cacheSet(), createOnRampOrder(), getCachedRequirementsByCountry(), getHarborMethodsWithSchemas(), getHarborTransferRequirements(), getHarborTransferStatus() (+11 more)

### Community 40 - "sep31Service.js"
Cohesion: 0.21
Nodes (14): amount, C, Transaction, handleCreateTransaction(), handleGetInfo(), handleGetTransaction(), handlePatchTransaction(), buildSep31TransactionObject() (+6 more)

### Community 41 - "marketingAgentController.js"
Cohesion: 0.31
Nodes (13): aprobar(), ERRORES_UPSTREAM, estadoModulo(), fail(), generar(), listarHistorial(), listarPendientes(), paginacion() (+5 more)

### Community 42 - "sep12Service.js"
Cohesion: 0.15
Nodes (19): handleDelete(), handleGet(), handlePut(), resolveOwnIdentity(), businessProfileSchema, kybDocumentSchema, legalRepresentativeSchema, transactionLimitsSchema (+11 more)

### Community 43 - "supportAgentService.js"
Cohesion: 0.29
Nodes (10): supportChatLimiter, chatSupport(), fallbackReply(), sanitizeHistory(), supportContact(), router, askSupport(), buildContextText() (+2 more)

### Community 44 - "Test KYB"
Cohesion: 0.22
Nodes (15): args, assert(), cleanupTestKYB(), colors, CREDS, log(), logFail(), logInfo() (+7 more)

### Community 45 - "stellarRoutes.js"
Cohesion: 0.31
Nodes (6): generalLimiter, getKeypairInfo(), provisionKeypair(), sep10Protect(), router, hasCustodialKeypair()

### Community 46 - "stellar.js"
Cohesion: 0.14
Nodes (17): ASSETS, BASE_FEE_STROOPS, horizonServer, NETWORK_INFO, NETWORK_PASSPHRASE, SEP10_SIGNING_PUBLIC, TX_TIMEOUT_SECONDS, renderStellarToml() (+9 more)

### Community 47 - "Plantillas Email SendGrid"
Cohesion: 0.32
Nodes (16): Template email admin: nuevo pago manual pendiente de verificar, Template email: deposito BOB acreditado en billetera, Template email: instrucciones de transferencia bancaria AV Finance SRL, Codigo de referencia obligatorio en el concepto de la transferencia, adminManualPayinAlert definido pero no llamado — fallback a adminBoliviaAlert, Tema visual claro de emails Alyto (#F0F4F8 / #1D3461, system-ui, tarjeta 580px), Catalogo SendGrid Dynamic Templates — payin manual Bolivia SRL, Template email admin: payout manual requerido corredor anchorBolivia (+8 more)

### Community 49 - "kybAnalysisService.js"
Cohesion: 0.24
Nodes (12): analyzeKyb(), blockKind(), buildDocumentBlocks(), businessSummary(), extractJson(), loadInstructions(), MAX_DOC_BYTES, MAX_DOCS (+4 more)

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

### Community 56 - "createQuote"
Cohesion: 0.14
Nodes (11): beneficiary_info, CUSTOMER_UUID, payout_instrument, allResults, COUNTRIES, schemaStr, beneficiary_info, fakeBeneficiary (+3 more)

### Community 57 - "Setup Stellar Mainnet"
Cohesion: 0.36
Nodes (13): ACCOUNTS, banner(), getAccountSafe(), getUSDCBalance(), getXLMBalance(), hasTrustline(), modeCheck(), modeGenerate() (+5 more)

### Community 58 - "kycController.js"
Cohesion: 0.22
Nodes (13): approveKycTest(), createKycSession(), getKycDebug(), getKycStatus(), getStripe(), HARD_REJECTION_CODES, runSanctionsScreening(), screenUserManual() (+5 more)

### Community 59 - "waitlistRoutes.js"
Cohesion: 0.20
Nodes (11): waitlistLimiter, clean(), csvCell(), exportCsv(), listEntries(), subscribe(), checkAdmin(), waitlistEntrySchema (+3 more)

### Community 60 - "marketingCampaignService.js"
Cohesion: 0.23
Nodes (9): CHANNELS, checkCompliance(), generateLandingHero(), MAX_TOKENS, MAX_VARIANTS, parseJsonArray(), runCampaign(), runChannel() (+1 more)

### Community 61 - "adminAuditService.js"
Cohesion: 0.16
Nodes (14): addSanction(), clearSanctionsFlag(), listFlaggedUsers(), listSanctions(), removeSanction(), adminAuditLogSchema, APPEND_ONLY, sanctionsListSchema (+6 more)

### Community 62 - "reconcileBankQrPayments.js"
Cohesion: 0.31
Nodes (14): handleBankQrIPN(), confirmBankQrDeposit(), failExpiredBankQrDeposit(), confirmBankQrTx(), failExpiredBankQrTx(), reconcileBankQrPayments(), reconcilePaidQRs(), sweepExpiredQRs() (+6 more)

### Community 63 - "Tests Servicio Stellar"
Cohesion: 0.14
Nodes (6): Asset, mockFetchBaseFee, MockHorizonServer, mockLoadAccount, mockSubmitTransaction, mockTransactionsCall

### Community 64 - "harbor-prod-test-transfer.mjs"
Cohesion: 0.15
Nodes (11): account, amount, args, bankName, baseUrl, beneficiary, CONFIRM, customerUuid (+3 more)

### Community 65 - "email.js"
Cohesion: 0.11
Nodes (17): _analyzeUser(), rosMonitor(), _sendAdminSummary(), thresholds(), _analyzeUser(), getBobPerUsdc(), MONITORED_MATCH, MONITORED_TYPES (+9 more)

### Community 66 - "custodyService.js"
Cohesion: 0.18
Nodes (19): EDITABLE, getWalletFeeConfig(), getWalletFeeRevenue(), harvestRevenueToTreasury(), NULLABLE, updateWalletFeeConfig(), createUsdcTrustline(), decryptSecretKey() (+11 more)

### Community 67 - "Test Harbor"
Cohesion: 0.38
Nodes (12): assert(), colors, HARBOR_BASE, harborRequest(), log(), logFail(), logInfo(), logOk() (+4 more)

### Community 68 - "ipn.test.js"
Cohesion: 0.11
Nodes (17): sendVitaIPN(), buildSortedBody(), generateVitaIPNHeaders(), mockVitaPricesResponse(), sortObjectKeys(), vitaPayinSucceededIPN(), vitaPayoutFailedIPN(), vitaPayoutSucceededIPN() (+9 more)

### Community 69 - "TransactionConfig"
Cohesion: 0.13
Nodes (14): spaCLPCorridors, corridors, corridors, owlPayBase, corridors, createCorridor(), deactivateCorridor(), getCorridorAnalytics() (+6 more)

### Community 70 - "test-sep-e2e.mjs"
Cohesion: 0.35
Nodes (10): C, http(), record(), results, testSep1(), testSep10(), testSep12(), testSep24() (+2 more)

### Community 71 - "environmentGuards.test.js"
Cohesion: 0.27
Nodes (8): DENIED_BODY, denyIfProduction(), sandboxOnly(), areSimulatorsAllowed(), isRealProductionEnv(), NON_PRODUCTION_NODE_ENV, shouldSimulatePayoutConfirmation(), SNAPSHOT

### Community 72 - "Aprovisionamiento Colas SQS"
Cohesion: 0.27
Nodes (8): DRY_RUN, ensureQueue(), getArn(), getUrl(), main(), MAX_RECEIVE, QUEUES, sqs

### Community 73 - "Diagnóstico CI Pendiente"
Cohesion: 0.20
Nodes (8): afectados, conCiReal, conMovimientos, conNit, fechas, ids, porEntidad, porEstado

### Community 74 - "User"
Cohesion: 0.14
Nodes (18): seedAdmin(), NOTIFICATION_SCHEMAS, sendNotification(), VALID_NOTIFICATION_TYPES, checkAliasAvailable(), getMyAlias(), normalizeAlias(), RESERVED (+10 more)

### Community 75 - "Simulación de Flujo"
Cohesion: 0.33
Nodes (9): createMockRequest(), createMockResponse(), __dirname, logState(), printBanner(), printSection(), runSimulation(), stateHistory (+1 more)

### Community 76 - "Contactos"
Cohesion: 0.31
Nodes (7): createContact(), deleteContact(), listContacts(), toggleFavorite(), updateContact(), contactSchema, router

### Community 77 - "WalletUSDC.js"
Cohesion: 0.28
Nodes (5): ACTIVE_STATUSES, buildBeneficiaryName(), getDashboard(), walletUSDCSchema, router

### Community 78 - "monitorChannelXLM.js"
Cohesion: 0.36
Nodes (7): ACCOUNT_LOW_THRESHOLD, CHANNEL_LOW_THRESHOLD, _lastAlertAt, monitorChannelXLM(), _publicKeyFromSecretEnv(), _shouldAlert(), getXLMBalance()

### Community 79 - "euAmountRouter.js"
Cohesion: 0.31
Nodes (8): getAvailableCorridors(), EU_SEPA_DESTINATIONS, HARBOR_MAX_USD, HARBOR_MIN_USD, isEuSepaDestination(), resolveEuCorridorByAmount(), convertOriginToUSD(), getCLPRate()

### Community 80 - "notificationRoutes.js"
Cohesion: 0.36
Nodes (5): getNotifications(), getUnreadCount(), markAsRead(), notificationSchema, router

### Community 81 - "stripeWebhook.js"
Cohesion: 0.44
Nodes (10): invalidateUserCache(), _approveKyc(), _findUserForSession(), getStripe(), handleStripeWebhook(), HARD_REJECTION_CODES, _persistVerifiedOutputs(), _recoverKyc() (+2 more)

### Community 82 - "Metadatos package.json"
Cohesion: 0.22
Nodes (8): author, description, keywords, license, main, name, type, version

### Community 83 - "supportKnowledge.js"
Cohesion: 0.16
Nodes (15): walletFeeConfigSchema, getHarborIndicativeRate(), _cache, COUNTRY_NAMES, EU_COUNTRIES, feeSummary(), fieldSummary(), formatCorridorKnowledge() (+7 more)

### Community 84 - "backfill-withdrawal-audit-trail.mjs"
Cohesion: 0.40
Nodes (4): APPLY, args, main(), PROD

### Community 85 - "SRLConfig"
Cohesion: 0.38
Nodes (9): deleteSRLQR(), deleteWalletSRLQR(), getSRLConfig(), toggleSRLQR(), toggleWalletSRLQR(), updateBankData(), uploadSRLQR(), uploadWalletSRLQR() (+1 more)

### Community 86 - "BoundedCache"
Cohesion: 0.20
Nodes (3): clearUserCache(), buildPayoutInstrument(), BoundedCache

### Community 87 - "Verificación Pública de Facturas"
Cohesion: 0.36
Nodes (7): esc(), formatDate(), formatMoney(), page(), STATUS_LABELS, verifyInvoice(), router

### Community 88 - "Test Admin Marketing"
Cohesion: 0.22
Nodes (5): ADMIN, app, completeMock, OTRO_ADMIN, USUARIO

### Community 89 - "setup.env.js"
Cohesion: 0.17
Nodes (5): serverKeypair, completeMock, baseCorridor, calculateQuote(), round2()

### Community 90 - "Exportar Corredores PDF"
Cohesion: 0.25
Nodes (7): col, countryArg, doc, groups, ORDER, PROVIDER_LABEL, providers

### Community 91 - "Fondeo USDC SRL"
Cohesion: 0.39
Nodes (7): colors, errors, getUSDCBalance(), info(), main(), ok(), warn()

### Community 92 - "Migración Usuarios Legacy"
Cohesion: 0.36
Nodes (7): buildKycDocuments(), COUNTRY_TO_ENTITY, ENTITY_DEFAULT_DOC_TYPE, KYC_STATUS_MAP, migrate(), resolveEntity(), resolveKycStatus()

### Community 93 - "validate-routing.js"
Cohesion: 0.20
Nodes (8): HARBOR_BASE, harborWins, mismatches, results, unknowns, vitaWins, getOwlPayApiKey(), getOwlPayBaseUrl()

### Community 94 - "audit-harbor-end-to-end.js"
Cohesion: 0.22
Nodes (7): CUSTOMER_UUID, results, TEST_CASES, CUSTOMER_UUID, payload, wireQuote, createTransfer()

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

### Community 100 - "sep10Service.js"
Cohesion: 0.44
Nodes (7): PRIORITY_FEE_STROOPS, getChallenge(), postVerify(), buildChallenge(), resolveWebAuthDomain(), sep10SigningKeypair(), verifyChallenge()

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

### Community 111 - "getCustomerUuid"
Cohesion: 0.39
Nodes (7): getHarborMethodsRequirements(), resolveProviderQuote(), execute(), createHarborTransfer(), getCustomerUuid(), getHarborQuote(), resolveHarborCountry()

### Community 112 - "checkEnv.js"
Cohesion: 0.33
Nodes (5): checkEnv(), CRITICAL, IMPORTANT, isMain, OPTIONAL

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
- **554 isolated node(s):** `TAB_FILTERS`, `__dirname`, `ROOT`, `SRC`, `C` (+549 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **40 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `dependencies` to `payoutController.js`, `Dependencia Bedrock Runtime`, `Dependencia X-Ray Core`, `Dependencia X-Ray Express`, `Dependencia Compression`, `Dependencia CORS`, `Dependencia Express`, `Dependencia Rate Limit`, `Dependencia JSON Web Token`, `Dependencia Mongoose`, `Dependencia PDFKit`, `Dependencia Sentry Node`, `Dependencia Sentry Profiling`, `Dependencia Stripe`, `Dependencia Winston`, `Dependencia Winston CloudWatch`, `Dependencia WebSocket ws`, `@aws-sdk/client-kms`, `Metadatos package.json`?**
  _High betweenness centrality (0.102) - this node is a cross-community bridge._
- **Why does `qrcode` connect `payoutController.js` to `err`, `fundingController.js`, `paymentController.js`, `dependencies`?**
  _High betweenness centrality (0.099) - this node is a cross-community bridge._
- **Why does `User` connect `User` to `payoutController.js`, `paymentController.js`, `sendEmail`, `anchorAdminService.js`, `NOTIFICATIONS`, `err`, `piiCrypto.js`, `adminRoutes.js`, `authController.js`, `quoteSocket.js`, `stellarService.js`, `db.js`, `userController.js`, `authMiddleware.js`, `kybController.js`, `ipnController.js`, `server.js`, `owlPayService.js`, `sep12Service.js`, `Test KYB`, `stellarRoutes.js`, `kycController.js`, `adminAuditService.js`, `reconcileBankQrPayments.js`, `email.js`, `custodyService.js`, `Simulación de Flujo`, `stripeWebhook.js`, `sep10Service.js`?**
  _High betweenness centrality (0.094) - this node is a cross-community bridge._
- **Are the 153 inferred relationships involving `err()` (e.g. with `checkAliasAvailable()` and `getMyAlias()`) actually correct?**
  _`err()` has 153 INFERRED edges - model-reasoned connections that need verification._
- **What connects `TAB_FILTERS`, `__dirname`, `ROOT` to the rest of the system?**
  _554 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `riskClassifier.js` be split into smaller, more focused modules?**
  _Cohesion score 0.11231884057971014 - nodes in this community are weakly interconnected._
- **Should `payoutController.js` be split into smaller, more focused modules?**
  _Cohesion score 0.07502131287297528 - nodes in this community are weakly interconnected._