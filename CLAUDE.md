# Contexto Global del Proyecto: Alyto Wallet V2.0

## 1. Identidad Corporativa, Entidades y Visión Operativa
* **Estructura Corporativa Multi-Jurisdicción:**
  * **AV Finance LLC (EE.UU. - Delaware):** Entidad matriz para relaciones bancarias en USD, infraestructura B2B global y gestión de liquidez institucional (ej. Harbor application con OwlPay).
  * **AV Finance SpA (Chile):** Entidad operativa en Antofagasta, enfocada en recaudación (Pay-in) local y pagos B2B.
  * **AV Finance SRL (Bolivia):** Entidad operativa (en vías de licencia como Empresa de Tecnología Financiera - ETF y Proveedor de Servicios de Activos Virtuales - PSAV). Actúa como Anchor regulado local.
* **Producto:** Alyto (Billetera digital y plataforma financiera Web3).
* **Core Business:** Pagos transfronterizos institucionales, gestión de tesorería y tokenización de activos sobre la red Stellar.
* **⚠️ REGLA CRÍTICA DE COMPLIANCE:** Está ESTRICTAMENTE PROHIBIDO utilizar la palabra "remesa", "remesas" o "remittances" en cualquier parte del código, comentarios, metadatos de APIs (especialmente Stripe), base de datos o interfaz de usuario. Utilizar siempre términos como "cross-border payment", "transferencia internacional", "pay-in/pay-out", "liquidación" o "tokenización".
* **Arquitectura de Funcionalidades por País:** El código DEBE instanciar lógicas, límites KYC/KYB y métodos de pago dinámicamente según el país de residencia del usuario y la entidad legal que procesa la operación (SpA, SRL o LLC).

## 2. Ecosistema de Integraciones y Motores Financieros (Stack de Herramientas)
Claude debe orquestar estas herramientas para crear una red global de liquidez, habilitando enrutamiento dinámico de fondos:

1. **Stellar Network (Autopista Core):**
   * *Uso:* Liquidación instantánea (T+0) de extremo a extremo.
   * *Características:* Gestión de Trustlines, autenticación SEP-10, transferencias de valor inter-billeteras con costo casi cero.
2. **OwlPay (Liquidez Institucional Global):**
   * *Uso:* Puente principal fiat-cripto y cripto-fiat.
   * *Características:* Capacidad completa de orquestación de On-Ramp y Off-Ramp. Liquidación B2B global y acceso a rieles institucionales.
   * *Docs:* https://harbor-developers.owlpay.com/docs/overview
3. **Stripe (Cobros, Emisión y Validación):**
   * *Uso:* Infraestructura B2B y procesamiento con tarjetas.
   * *Características:* Emisión de tarjetas corporativas, cobros globales, prevención de fraude avanzada y validación de identidad (Stripe Identity).
4. **Fintoc (Open Banking LatAm):**
   * *Uso:* Motor de recaudación local automatizado.
   * *Características:* Iniciación de pagos cuenta a cuenta (A2A), ideal para el Pay-in inicial en Chile (conectado a AV Finance SpA) con confirmación en tiempo real.
5. **Vita Wallet (Anchor de Dispersión Regional):**
   * *Uso:* Motor de salida (Off-Ramp) secundario o complementario.
   * *Características:* Dispersión de fondos hacia cuentas bancarias locales en múltiples países de Latinoamérica.
   * *Docs:* `/home/avf/Desarrollo/BusinessAPI.txt` (Leer archivo local).
6. **BP Ventures / Anclap (Infraestructura SEP y Stablecoins):**
   * *Uso:* Proveedor de activos estables regionales e infraestructura SEP.
   * *Características:* Referencia técnica obligatoria. El repositorio "CLPX" se utilizará exclusivamente en modo de lectura para extraer lógica criptográfica.
7. **Ramp Network (Infraestructura Descentralizada):**
   * *Uso:* Soluciones complementarias de Swaps y On/Off-Ramp directo a la billetera.

## 3. Topología de Corredores y Flujos de Fondos (Expansión Global)
La arquitectura no debe estar acotada a un solo corredor. El backend debe estar preparado para enrutar transacciones multi-corredor de forma dinámica:
* **Pay-in Dinámico:** Fintoc (Chile), Stripe (Global), o transferencias bancarias a las entidades correspondientes.
* **Tránsito Web3:** Conversión de fiat a activos digitales (USDC/XLM) en Stellar.
* **Off-Ramp Dinámico:** OwlPay (Global), Vita Wallet (LatAm) o nuestro Anchor Manual (Bolivia).

## 4. Hitos Legales y de Compliance Específicos
* **Bolivia (Anchor Manual y ETF/PSAV):** Toda operación liquidada a través de AV Finance SRL exige la generación automática de un documento en PDF denominado "Comprobante Oficial de Transacción". Debe incluir: Datos de la SRL, KYC del cliente (NIT/CI), TXID de Stellar, y el desglose financiero exacto con el footer legal para deducciones de impuestos (IUE/IVA).

## 5. Arquitectura de Repositorios (Aislamiento V2.0)
* **Nuevos repositorios (Destino Alyto V2.0):** * Frontend: `/home/avf/Desarrollo/alyto-frontend-v2`
  * Backend: `/home/avf/Desarrollo/alyto-backend-v2`
* **Repositorios de Referencia (Origen V1.5):** * Backend V1.5: `/home/avf/Desarrollo/alyto-backend`
  * Frontend V1.5: `/home/avf/Desarrollo/alyto-frontend`
* **Stack Principal:** Node.js, Express.js, MongoDB (Backend) / React.js, Vite, Tailwind CSS (Frontend).
* **Directiva de Desarrollo:** Claude DEBE leer los archivos locales de la V1.5 para migrar modelos de datos, flujos de servidores y componentes UI, adaptándolos a la nueva arquitectura basada en Stellar y multi-entidad.

## 6. Instrucciones de Comportamiento para Claude Code
1. **Seguridad Absoluta:** Nunca exponer llaves privadas, Secret Keys de Stripe, ni Secrets de Stellar en el código fuente. Usar SIEMPRE variables de entorno (`.env`).
2. **Eficiencia de Código:** Antes de escribir una función criptográfica desde cero, buscar si ya fue resuelta en los repositorios locales de la V1.5.
3. **Arquitectura Multi-Entidad:** Al crear modelos de base de datos o controladores, implementar siempre un campo o middleware que identifique bajo qué jurisdicción (LLC, SpA, SRL) se está ejecutando la transacción para aplicar las reglas de compliance correctas.
4. **Resiliencia (Fallbacks):** Implementar rutas alternativas de enrutamiento. Si un motor de On/Off-ramp falla, el sistema debe registrar el error sin colapsar y notificar al orquestador para usar un proveedor secundario.

## 7. Directivas de Skills Nativos (Uso Obligatorio)
El entorno de Claude Code cuenta con Skills personalizados instalados globalmente. Claude DEBE invocar el contexto de estas habilidades según la tarea solicitada:
* **`ux-alyto`**: ACTIVAR OBLIGATORIAMENTE para cualquier creación o modificación de componentes visuales en React/Vite. Aplica la paleta institucional (Azul/Amarillo Alyto) y la estructura UI de tarjetas.
* **`Stellar_Integration_Alyto`**: ACTIVAR OBLIGATORIAMENTE al programar funciones de red blockchain. Aplica las reglas estrictas de *Fee Bump Transactions* corporativas, gestión de Trustlines y manejo de cuentas canal.
* **`Compliance_Bolivia_Alyto`**: ACTIVAR OBLIGATORIAMENTE al diseñar el motor de facturación o reportes para la entidad SRL. Define el uso de `pdfkit` y la estructura exacta del Comprobante Oficial de Transacción.
* **`Multi_Entity_Routing_Alyto`**: ACTIVAR OBLIGATORIAMENTE al crear controladores de pagos o flujos de fondos. Es el mapa lógico para decidir qué motor usar (Fintoc, Stripe, OwlPay o Anchor Manual) dependiendo de la jurisdicción del usuario y el destino del capital.