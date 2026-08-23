# Graph Report - alyto-backend-v2  (2026-08-23)

## Corpus Check
- 381 files · ~376,118 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2152 nodes · 5516 edges · 163 communities (120 shown, 43 thin omitted)
- Extraction: 89% EXTRACTED · 11% INFERRED · 0% AMBIGUOUS · INFERRED: 584 edges (avg confidence: 0.74)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `39e3f231`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- riskClassifier.js
- payoutController.js
- llmProvider.js
- paymentController.js
- reclamosController.js
- vitaWalletService.js
- anchorAdminService.js
- NOTIFICATIONS
- err
- stripeWebhook.js
- adminTwoFactorService.js
- ledgerAdminController.js
- adminController.js
- exchangeRateService.js
- authController.js
- quoteSocket.js
- Orquestación y Fallback de Proveedores
- becAccountService.js
- stellarService.js
- db.js
- adminTwoFactorController.js
- Migración S3 y Object Lock
- becQrService.js
- dependencies
- ipnQueueConsumer.js
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
- stellarRoutes.js
- marketingAgentController.js
- sep12Service.js
- supportAgentService.js
- accessLogService.js
- bankAdminController.js
- stellar.js
- Plantillas Email SendGrid
- @aws-sdk/client-kms
- kybAnalysisService.js
- test-bec-payin.mjs
- authTokenService.js
- integration/admin2fa.test.js
- createWidgetLink
- test-owlpay-schema.js
- BusinessProfile.js
- createQuote
- Setup Stellar Mainnet
- adminRoutes.js
- waitlistRoutes.js
- marketingCampaignService.js
- recordAdminAction
- reconcileBankQrPayments.js
- Tests Servicio Stellar
- harbor-prod-test-transfer.mjs
- email.js
- custodyService.js
- vitaErrorMapper.js
- ipn.test.js
- TransactionConfig
- test-sep-e2e.mjs
- environmentGuards.test.js
- Aprovisionamiento Colas SQS
- adminSandboxGuards.test.js
- User
- idempotency.js
- Contactos
- walletFeeController.js
- notificationRoutes.js
- Metadatos package.json
- supportKnowledge.js
- SRLConfig
- BoundedCache
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
2. `User` - 150 edges
3. `NOTIFICATIONS` - 51 edges
4. `notify()` - 50 edges
5. `logger` - 47 edges
6. `TransactionConfig` - 44 edges
7. `dispatchPayout()` - 36 edges
8. `sendEmail()` - 32 edges
9. `protect()` - 29 edges
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

## Communities (163 total, 43 thin omitted)

### Community 0 - "riskClassifier.js"
Cohesion: 0.11
Nodes (20): clasificarRiesgo(), coincidenciasDe(), MOTIVOS, normalizar(), RE_CIFRAS, RE_COSTO_CERO, RE_LEGAL, RE_MARCA (+12 more)

### Community 1 - "payoutController.js"
Cohesion: 0.06
Nodes (68): qrcode, qrcode, createMockRequest(), createMockResponse(), __dirname, logState(), printBanner(), printSection() (+60 more)

### Community 2 - "llmProvider.js"
Cohesion: 0.23
Nodes (13): extractJson(), imageMediaType(), isBedrockEnabled(), MAX_TOKENS, parseComprobante(), BEDROCK_IMAGE_FORMAT, complete(), completeAnthropic() (+5 more)

### Community 3 - "paymentController.js"
Cohesion: 0.09
Nodes (32): COUNTRY_META, FALLBACK_WITHDRAWAL_RULES, fintocWebhook(), flattenHarborSchema(), getAvailableCorridors(), getHarborMethodsRequirements(), getPayinMethods(), getSRLPayinInstructions() (+24 more)

### Community 4 - "reclamosController.js"
Cohesion: 0.17
Nodes (12): adminGetReclamo(), adminListarReclamos(), adminReclamosVencimientos(), adminResponderReclamo(), crearReclamo(), getReclamo(), listarReclamos(), subirDocumentosReclamo() (+4 more)

### Community 5 - "vitaWalletService.js"
Cohesion: 0.10
Nodes (44): checkEnv(), __dirname, ENV_FILE, fail(), ok(), OUTPUT_DIR, patchEnvWalletUuid(), printSummary() (+36 more)

### Community 6 - "anchorAdminService.js"
Cohesion: 0.10
Nodes (40): handleAuditLog(), handleFrozenWallets(), handleListenerStatus(), handleReconciliation(), handleSolvency(), handleTreasuryStatus(), getUSDCForecast(), _adminEmail() (+32 more)

### Community 7 - "NOTIFICATIONS"
Cohesion: 0.11
Nodes (36): deleteAccount(), uploadPaymentProof(), uploadDepositProof(), adminConfirmBOBtoUSDC(), adminConfirmUSDCtoBOB(), adminListAllConversions(), adminListPendingConversions(), adminListPendingUSDCtoBOB() (+28 more)

### Community 8 - "err"
Cohesion: 0.10
Nodes (40): err(), handleBecDisbursementIPN(), generateWalletQR(), previewQR(), scanAndPayQR(), adminAttachWithdrawalComprobante(), adminConfirmWithdrawal(), adminDispatchWithdrawal() (+32 more)

### Community 9 - "stripeWebhook.js"
Cohesion: 0.06
Nodes (75): afectados, conCiReal, conMovimientos, conNit, fechas, ids, porEntidad, porEstado (+67 more)

### Community 10 - "adminTwoFactorService.js"
Cohesion: 0.16
Nodes (25): RFC-4226, RFC-4648, RFC-6238, checkAdmin(), beginEnrollment(), generateRecoveryCodes(), isAdminTwoFactorEnabled(), issuerName() (+17 more)

### Community 11 - "ledgerAdminController.js"
Cohesion: 0.06
Nodes (70): args, COMMIT, lines, COMMIT, args, fail(), handleBalanceSheet(), handleClosedThrough() (+62 more)

### Community 12 - "adminController.js"
Cohesion: 0.09
Nodes (28): CORRIDOR_PROTECTED_FIELDS, createCorridor(), currentUserField(), deactivateCorridor(), FORCED_TERMINAL_STATUSES, getAllUsers(), getCorridorAnalytics(), getGlobalLedger() (+20 more)

### Community 13 - "exchangeRateService.js"
Cohesion: 0.14
Nodes (28): deleteBOBUSDCOverride(), getCLPBOBRate(), getPublicExchangeRate(), getPublicExchangeRates(), listExchangeRates(), updateCLPBOBRate(), upsertExchangeRate(), refreshExchangeRates() (+20 more)

### Community 14 - "authController.js"
Cohesion: 0.12
Nodes (28): emailVerifyLimiter, forgotPasswordLimiter, generalLimiter, loginLimiter, makeLimiter(), paymentsLimiter, registerLimiter, resetPasswordLimiter (+20 more)

### Community 15 - "quoteSocket.js"
Cohesion: 0.14
Nodes (27): RFC-6265, getVitaAmount(), extractVitaPricing(), CACHE_REFRESH_BEFORE_EXPIRY, computeQuote(), connectionCount(), connectionsPerUser, createQuoteSocketServer() (+19 more)

### Community 16 - "Orquestación y Fallback de Proveedores"
Cohesion: 0.10
Nodes (17): becQrProvider, execute(), getStripe(), ZERO_DECIMAL_CURRENCIES, buildBoliviaCompliancePayload(), buildPayinPayload(), buildPayoutPayload(), buildTransitPayload() (+9 more)

### Community 17 - "becAccountService.js"
Cohesion: 0.14
Nodes (25): adapters, banecoAdapter, fmtDate(), getBalance(), getEncryptedAccount(), getMovements(), isAvailable(), queryAccount() (+17 more)

### Community 18 - "stellarService.js"
Cohesion: 0.09
Nodes (31): APPLY, args, main(), PROD, ACCOUNT_LOW_THRESHOLD, CHANNEL_LOW_THRESHOLD, _lastAlertAt, monitorChannelXLM() (+23 more)

### Community 19 - "db.js"
Cohesion: 0.17
Nodes (11): createAdminUser(), createSpAUser(), createSRLUser(), clearCollections(), connectTestDb(), disconnectTestDb(), seedCorridor(), seedCorridorClCo() (+3 more)

### Community 20 - "adminTwoFactorController.js"
Cohesion: 0.27
Nodes (17): confirm(), enroll(), loadChallengeUser(), reset(), status(), verify(), isLockedOut(), confirmEnrollment() (+9 more)

### Community 21 - "Migración S3 y Object Lock"
Cohesion: 0.09
Nodes (19): DEST, destS3, DRY_RUN, existsInDest(), main(), SRC, srcS3, streamToBuffer() (+11 more)

### Community 22 - "becQrService.js"
Cohesion: 0.23
Nodes (17): apiFetch(), authenticate(), cancelQR(), cfg, encryptAes(), generateQR(), getEncryptedAccount(), getPaidQRs() (+9 more)

### Community 23 - "dependencies"
Cohesion: 0.07
Nodes (27): @anthropic-ai/sdk, @aws-sdk/client-s3, @aws-sdk/client-secrets-manager, @aws-sdk/client-sqs, @aws-sdk/s3-request-presigner, bcryptjs, cookie-parser, dotenv (+19 more)

### Community 24 - "ipnQueueConsumer.js"
Cohesion: 0.20
Nodes (12): handleFintocIPN(), HANDLERS, makeFakeRes(), startIpnConsumerJob(), router, enqueueIpnEvent(), getClient(), isSqsEnabled() (+4 more)

### Community 25 - "marketingAgentService.js"
Cohesion: 0.22
Nodes (12): getMarketingAgentSystemPrompt(), contentPieceSchema, CAMPOS, CANALES, cfg(), generarContenido(), isMarketingAgentEnabled(), normalizar() (+4 more)

### Community 26 - "authMiddleware.js"
Cohesion: 0.16
Nodes (14): clearUserCache(), getCachedUser(), protect(), requireAdmin(), requireEntity(), requireKycApproved(), setCachedUser(), userCache (+6 more)

### Community 27 - "Scripts NPM"
Cohesion: 0.08
Nodes (25): scripts, check:env, check:production, dev, email:test, fund:srl, fund:srl:1000, fund:srl:500 (+17 more)

### Community 28 - "kybController.js"
Cohesion: 0.18
Nodes (15): applyKYB(), downloadKYBDocument(), fileToBase64(), getKYBApplication(), getKYBStatus(), listKYBApplications(), runKybAiAnalysis(), uploadKYBDocuments() (+7 more)

### Community 29 - "Transaction.js"
Cohesion: 0.05
Nodes (38): cursor, date(), dline, line, buildPayload(), run(), ACTIVE_STATUSES, buildBeneficiaryName() (+30 more)

### Community 30 - "ipnController.js"
Cohesion: 0.13
Nodes (42): CONFIRM, TXID, simulateBankQrPayment(), updateTransactionStatus(), recordSent(), appendIpnLog(), buildBeneficiaryPayloads(), buildOwlPayBeneficiary() (+34 more)

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
Cohesion: 0.17
Nodes (12): renderStellarToml(), cleanupOrphanTransactions(), cleanupOrphanWalletDeposits(), sentryContext(), allowedOrigins, ANCHOR_CORS_BASE, app, dropLegacyIndexes() (+4 more)

### Community 35 - "checkProduction.js"
Cohesion: 0.25
Nodes (18): buildVitaSignature(), C, checkData(), checkEnvVars(), checkMongoDB(), checkSecurity(), checkSendGrid(), checkVita() (+10 more)

### Community 36 - "awsSecrets.js"
Cohesion: 0.12
Nodes (12): darDeAlta(), args, brief, DELAY_MS, failures, ENC_CONTEXT, kms, auditSecrets() (+4 more)

### Community 37 - "logger.js"
Cohesion: 0.16
Nodes (10): jobNames(), JOBS, runJob(), router, devFormat, jsonFormat, logger, patchConsole() (+2 more)

### Community 38 - "owlPayService.js"
Cohesion: 0.17
Nodes (19): initiateCorporateOnRamp(), cacheGet(), cacheSet(), createOnRampOrder(), getCachedRequirementsByCountry(), getHarborMethodsWithSchemas(), getHarborTransferRequirements(), getHarborTransferStatus() (+11 more)

### Community 40 - "stellarRoutes.js"
Cohesion: 0.20
Nodes (15): amount, C, Transaction, handleCreateTransaction(), handleGetInfo(), handleGetTransaction(), handlePatchTransaction(), router (+7 more)

### Community 41 - "marketingAgentController.js"
Cohesion: 0.31
Nodes (13): aprobar(), ERRORES_UPSTREAM, estadoModulo(), fail(), generar(), listarHistorial(), listarPendientes(), paginacion() (+5 more)

### Community 42 - "sep12Service.js"
Cohesion: 0.21
Nodes (15): handleDelete(), handleGet(), handlePut(), resolveOwnIdentity(), buildMissingFields(), buildProvidedFields(), deleteCustomer(), getCustomer() (+7 more)

### Community 43 - "supportAgentService.js"
Cohesion: 0.29
Nodes (10): supportChatLimiter, chatSupport(), fallbackReply(), sanitizeHistory(), supportContact(), router, askSupport(), buildContextText() (+2 more)

### Community 44 - "accessLogService.js"
Cohesion: 0.25
Nodes (13): loginUser(), accessLogSchema, APPEND_ONLY, lockoutMinutes(), lockoutUntilFor(), maxFailedAttempts(), nextLockoutState(), recordAccess() (+5 more)

### Community 45 - "bankAdminController.js"
Cohesion: 0.26
Nodes (12): BALANCE_TTL_MS, _balanceCache, ensureDefaultBankAccounts(), getBankBalance(), getBankMovements(), getTreasuryCoverage(), getUserWalletSummary(), listBanks() (+4 more)

### Community 46 - "stellar.js"
Cohesion: 0.15
Nodes (16): ASSETS, BASE_FEE_STROOPS, horizonServer, NETWORK_INFO, NETWORK_PASSPHRASE, SEP10_SIGNING_PUBLIC, TX_TIMEOUT_SECONDS, cursorKeyFor() (+8 more)

### Community 47 - "Plantillas Email SendGrid"
Cohesion: 0.32
Nodes (16): Template email admin: nuevo pago manual pendiente de verificar, Template email: deposito BOB acreditado en billetera, Template email: instrucciones de transferencia bancaria AV Finance SRL, Codigo de referencia obligatorio en el concepto de la transferencia, adminManualPayinAlert definido pero no llamado — fallback a adminBoliviaAlert, Tema visual claro de emails Alyto (#F0F4F8 / #1D3461, system-ui, tarjeta 580px), Catalogo SendGrid Dynamic Templates — payin manual Bolivia SRL, Template email admin: payout manual requerido corredor anchorBolivia (+8 more)

### Community 49 - "kybAnalysisService.js"
Cohesion: 0.24
Nodes (12): analyzeKyb(), blockKind(), buildDocumentBlocks(), businessSummary(), extractJson(), loadInstructions(), MAX_DOC_BYTES, MAX_DOCS (+4 more)

### Community 50 - "test-bec-payin.mjs"
Cohesion: 0.24
Nodes (7): amount, args, cancelAfter, cipherOnly, fmtDate(), main(), mask()

### Community 51 - "authTokenService.js"
Cohesion: 0.24
Nodes (8): requireTwoFactorChallenge(), AMR_OTP, AMR_PASSWORD, AMR_RECOVERY_CODE, CHALLENGE_PURPOSE, CHALLENGE_TTL_SECONDS, generateChallengeToken(), verifyChallengeToken()

### Community 52 - "integration/admin2fa.test.js"
Cohesion: 0.54
Nodes (7): codigoSiguiente(), crearAdmin(), darDeAlta(), login(), post2fa(), secretoDe(), sesionAdmin()

### Community 53 - "createWidgetLink"
Cohesion: 0.48
Nodes (4): execute(), createWidgetLink(), fintocRequest(), getPaymentIntent()

### Community 54 - "test-owlpay-schema.js"
Cohesion: 0.33
Nodes (5): beneficiary_info, fakeBeneficiary, payout_instrument, buildPayoutInstrument(), createHarborTransfer()

### Community 55 - "BusinessProfile.js"
Cohesion: 0.40
Nodes (4): businessProfileSchema, kybDocumentSchema, legalRepresentativeSchema, transactionLimitsSchema

### Community 56 - "createQuote"
Cohesion: 0.18
Nodes (8): beneficiary_info, CUSTOMER_UUID, payout_instrument, allResults, COUNTRIES, schemaStr, createQuote(), getRequirementsSchema()

### Community 57 - "Setup Stellar Mainnet"
Cohesion: 0.36
Nodes (13): ACCOUNTS, banner(), getAccountSafe(), getUSDCBalance(), getXLMBalance(), hasTrustline(), modeCheck(), modeGenerate() (+5 more)

### Community 58 - "adminRoutes.js"
Cohesion: 0.18
Nodes (14): getNotificationTypes(), addSanction(), clearSanctionsFlag(), listFlaggedUsers(), listSanctions(), removeSanction(), screenUserManual(), getSpAConfig() (+6 more)

### Community 59 - "waitlistRoutes.js"
Cohesion: 0.23
Nodes (10): waitlistLimiter, clean(), csvCell(), exportCsv(), listEntries(), subscribe(), waitlistEntrySchema, router (+2 more)

### Community 60 - "marketingCampaignService.js"
Cohesion: 0.23
Nodes (9): CHANNELS, checkCompliance(), generateLandingHero(), MAX_TOKENS, MAX_VARIANTS, parseJsonArray(), runCampaign(), runChannel() (+1 more)

### Community 61 - "recordAdminAction"
Cohesion: 0.31
Nodes (8): adminAuditLogSchema, APPEND_ONLY, buildAuditRecord(), ipFromReq(), isSensitiveKey(), recordAdminAction(), redactSensitive(), SENSITIVE_KEY_PATTERNS

### Community 62 - "reconcileBankQrPayments.js"
Cohesion: 0.33
Nodes (13): handleBankQrIPN(), confirmBankQrDeposit(), failExpiredBankQrDeposit(), confirmBankQrTx(), reconcileBankQrPayments(), reconcilePaidQRs(), sweepExpiredQRs(), sweepExpiredWalletQRs() (+5 more)

### Community 63 - "Tests Servicio Stellar"
Cohesion: 0.14
Nodes (6): Asset, mockFetchBaseFee, MockHorizonServer, mockLoadAccount, mockSubmitTransaction, mockTransactionsCall

### Community 64 - "harbor-prod-test-transfer.mjs"
Cohesion: 0.15
Nodes (11): account, amount, args, bankName, baseUrl, beneficiary, CONFIRM, customerUuid (+3 more)

### Community 65 - "email.js"
Cohesion: 0.11
Nodes (18): mockTransaction, mockUser, TESTS, resendVerification(), reconcileStellarTransits(), _analyzeUser(), getBobPerUsdc(), MONITORED_MATCH (+10 more)

### Community 66 - "custodyService.js"
Cohesion: 0.25
Nodes (14): getKeypairInfo(), provisionKeypair(), createUsdcTrustline(), decryptSecretKey(), encryptSecretKey(), fallbackDecrypt(), fallbackEncrypt(), fundUserAccount() (+6 more)

### Community 67 - "vitaErrorMapper.js"
Cohesion: 0.60
Nodes (4): extractVitaData(), FIELD_LABELS_ES, fieldLabel(), mapVitaError()

### Community 68 - "ipn.test.js"
Cohesion: 0.11
Nodes (17): sendVitaIPN(), buildSortedBody(), generateVitaIPNHeaders(), mockVitaPricesResponse(), sortObjectKeys(), vitaPayinSucceededIPN(), vitaPayoutFailedIPN(), vitaPayoutSucceededIPN() (+9 more)

### Community 69 - "TransactionConfig"
Cohesion: 0.11
Nodes (18): spaCLPCorridors, CORREDORES, seedCorredores(), corridors, corridors, owlPayBase, corridors, getCorridorRates() (+10 more)

### Community 70 - "test-sep-e2e.mjs"
Cohesion: 0.35
Nodes (10): C, http(), record(), results, testSep1(), testSep10(), testSep12(), testSep24() (+2 more)

### Community 71 - "environmentGuards.test.js"
Cohesion: 0.27
Nodes (8): DENIED_BODY, denyIfProduction(), sandboxOnly(), areSimulatorsAllowed(), isRealProductionEnv(), NON_PRODUCTION_NODE_ENV, shouldSimulatePayoutConfirmation(), SNAPSHOT

### Community 72 - "Aprovisionamiento Colas SQS"
Cohesion: 0.27
Nodes (8): DRY_RUN, ensureQueue(), getArn(), getUrl(), main(), MAX_RECEIVE, QUEUES, sqs

### Community 74 - "User"
Cohesion: 0.12
Nodes (21): seedAdmin(), testPush(), NOTIFICATION_SCHEMAS, sendNotification(), VALID_NOTIFICATION_TYPES, checkAliasAvailable(), getMyAlias(), normalizeAlias() (+13 more)

### Community 76 - "Contactos"
Cohesion: 0.31
Nodes (7): createContact(), deleteContact(), listContacts(), toggleFavorite(), updateContact(), contactSchema, router

### Community 77 - "walletFeeController.js"
Cohesion: 0.22
Nodes (8): EDITABLE, getWalletFeeConfig(), getWalletFeeRevenue(), harvestRevenueToTreasury(), NULLABLE, updateWalletFeeConfig(), walletUSDCSchema, sendCustodialUSDC()

### Community 80 - "notificationRoutes.js"
Cohesion: 0.53
Nodes (4): getNotifications(), getUnreadCount(), markAsRead(), router

### Community 82 - "Metadatos package.json"
Cohesion: 0.22
Nodes (8): author, description, keywords, license, main, name, type, version

### Community 83 - "supportKnowledge.js"
Cohesion: 0.16
Nodes (15): walletFeeConfigSchema, getHarborIndicativeRate(), _cache, COUNTRY_NAMES, EU_COUNTRIES, feeSummary(), fieldSummary(), formatCorridorKnowledge() (+7 more)

### Community 85 - "SRLConfig"
Cohesion: 0.27
Nodes (11): deleteSRLQR(), deleteWalletSRLQR(), getSRLConfig(), toggleSRLQR(), toggleWalletSRLQR(), updateBankData(), uploadSRLQR(), uploadWalletSRLQR() (+3 more)

### Community 88 - "Test Admin Marketing"
Cohesion: 0.22
Nodes (5): ADMIN, app, completeMock, OTRO_ADMIN, USUARIO

### Community 89 - "setup.env.js"
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
Cohesion: 0.36
Nodes (8): PRIORITY_FEE_STROOPS, getChallenge(), postVerify(), buildChallenge(), resolveWebAuthDomain(), sep10SigningKeypair(), verifyChallenge(), requireEnvSecret()

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
Cohesion: 0.24
Nodes (12): calculateBOBQuote(), getQuote(), resolveProviderQuote(), spAConfigSchema, execute(), getCustomerUuid(), getHarborQuote(), calculateQuote() (+4 more)

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
- **522 isolated node(s):** `COUNTRY_TO_ENTITY`, `ENTITY_DEFAULT_DOC`, `AUTH_COOKIE_NAME`, `userCache`, `accessLogSchema` (+517 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **43 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `User` connect `User` to `payoutController.js`, `paymentController.js`, `reclamosController.js`, `anchorAdminService.js`, `NOTIFICATIONS`, `err`, `stripeWebhook.js`, `adminTwoFactorService.js`, `adminController.js`, `authController.js`, `quoteSocket.js`, `stellarService.js`, `db.js`, `adminTwoFactorController.js`, `authMiddleware.js`, `kybController.js`, `Transaction.js`, `ipnController.js`, `server.js`, `awsSecrets.js`, `owlPayService.js`, `sep12Service.js`, `accessLogService.js`, `integration/admin2fa.test.js`, `adminRoutes.js`, `reconcileBankQrPayments.js`, `email.js`, `custodyService.js`, `walletFeeController.js`, `sep10Service.js`?**
  _High betweenness centrality (0.132) - this node is a cross-community bridge._
- **Why does `logger` connect `logger.js` to `llmProvider.js`, `paymentController.js`, `anchorAdminService.js`, `NOTIFICATIONS`, `stripeWebhook.js`, `adminTwoFactorService.js`, `ledgerAdminController.js`, `becAccountService.js`, `adminTwoFactorController.js`, `becQrService.js`, `ipnQueueConsumer.js`, `marketingAgentService.js`, `authMiddleware.js`, `ipnController.js`, `sep24Service.js`, `server.js`, `stellarRoutes.js`, `marketingAgentController.js`, `sep12Service.js`, `supportAgentService.js`, `accessLogService.js`, `bankAdminController.js`, `kybAnalysisService.js`, `waitlistRoutes.js`, `marketingCampaignService.js`, `recordAdminAction`, `reconcileBankQrPayments.js`, `custodyService.js`, `environmentGuards.test.js`, `walletFeeController.js`, `supportKnowledge.js`, `sep10Service.js`?**
  _High betweenness centrality (0.078) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `payoutController.js`, `Dependencia Bedrock Runtime`, `Dependencia X-Ray Core`, `Dependencia X-Ray Express`, `Dependencia Compression`, `Dependencia CORS`, `Dependencia Express`, `Dependencia Rate Limit`, `Dependencia JSON Web Token`, `Dependencia Mongoose`, `Dependencia PDFKit`, `Dependencia Sentry Node`, `Dependencia Sentry Profiling`, `Dependencia Stripe`, `Dependencia Winston`, `Dependencia Winston CloudWatch`, `Dependencia WebSocket ws`, `@aws-sdk/client-kms`, `Metadatos package.json`?**
  _High betweenness centrality (0.076) - this node is a cross-community bridge._
- **Are the 153 inferred relationships involving `err()` (e.g. with `checkAliasAvailable()` and `getMyAlias()`) actually correct?**
  _`err()` has 153 INFERRED edges - model-reasoned connections that need verification._
- **What connects `COUNTRY_TO_ENTITY`, `ENTITY_DEFAULT_DOC`, `AUTH_COOKIE_NAME` to the rest of the system?**
  _522 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `riskClassifier.js` be split into smaller, more focused modules?**
  _Cohesion score 0.11231884057971014 - nodes in this community are weakly interconnected._
- **Should `payoutController.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06296656929568321 - nodes in this community are weakly interconnected._