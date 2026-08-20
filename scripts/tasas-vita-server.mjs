/**
 * tasas-vita-server.mjs — Página local de tasas/conversor (Chile → LatAm).
 *
 * Servidor HTTP mínimo (Node puro, sin deps nuevas). Consulta Vita con las
 * credenciales del `.env` del repo y muestra:
 *   - Tasas (arriba): CO/PE/VE con 2% de ganancia + Chile→Bolivia MANUAL (vía USDT).
 *   - Campos de compra/venta de USDT (arriba) que arman la tasa CLP→BOB.
 *   - Conversor: monto en CLP → monto en moneda destino.
 * Uso local — NO es un endpoint de la app.
 *
 *   node scripts/tasas-vita-server.mjs   → http://localhost:4599
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const { getPrices } = await import('../src/services/vitaWalletService.js');

const PORT   = Number(process.env.TASAS_PORT ?? 4599);
const MARGEN = 0.02; // 2% de ganancia sobre la tasa Vita
const PAISES = [
  { code: 'co', nombre: 'Colombia',  moneda: 'COP', flag: '🇨🇴', dec: 0 },
  { code: 'pe', nombre: 'Perú',      moneda: 'PEN', flag: '🇵🇪', dec: 2 },
  { code: 've', nombre: 'Venezuela', moneda: 'VES', flag: '🇻🇪', dec: 2 },
];

let LOGO_SVG = '';
try { LOGO_SVG = readFileSync(join(__dirname, '..', '..', 'Logos', 'logo_avf_b.svg'), 'utf8'); }
catch { LOGO_SVG = ''; }

async function getVitaRates() {
  const r = await getPrices();
  const attrs = r?.clp?.withdrawal?.prices?.attributes ?? {};
  const sell  = attrs.clp_sell ?? {};
  return {
    validUntil: attrs.valid_until ?? null,
    rates: PAISES.map((p) => ({
      ...p,
      base:   Number(sell[p.code]),                // 1 CLP = X destino (Vita cruda)
      conFee: Number(sell[p.code]) * (1 - MARGEN), // con 2%
    })),
  };
}

function page({ validUntil, rates }, error) {
  const ratesJson = JSON.stringify(rates.map(({ code, nombre, moneda, flag, dec, base, conFee }) =>
    ({ code, nombre, moneda, flag, dec, base, rate: conFee })));
  const aviso = error ? `<div class="error">No se pudieron obtener las tasas de Vita.<br><code>${error}</code></div>` : '';

  return `<!doctype html><html lang="es"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Conversor de tasas · Chile → LatAm</title>
    <style>
      :root{
        --bg:#EEF2F8; --card:#FFFFFF; --line:#E1E7F1; --ink:#122533; --muted:#6B7A90;
        --accent:#122533; --pos:#0E7C66; --posbg:#E8F5F0; --field:#F7F9FC;
      }
      *{box-sizing:border-box}
      body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);
           font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
           padding:28px 16px;display:flex;justify-content:center}
      .wrap{width:100%;max-width:680px}
      header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}
      .logo{height:40px} .logo svg{height:40px;width:auto;display:block}
      header .sub{color:var(--muted);font-size:12px;text-align:right;line-height:1.35}
      .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px 22px 20px;
            margin-bottom:18px;box-shadow:0 6px 24px rgba(18,37,51,.06)}
      .card h2{margin:0 0 4px;font-size:15px;font-weight:650;letter-spacing:.2px}
      .card p.hint{margin:0 0 16px;color:var(--muted);font-size:12.5px}
      label{display:block;font-size:12px;color:var(--muted);font-weight:500;margin-bottom:6px}
      input{width:100%;background:var(--field);border:1px solid var(--line);border-radius:10px;
            padding:12px 13px;font-size:16px;color:var(--ink);font-variant-numeric:tabular-nums;outline:none;
            transition:border-color .15s, box-shadow .15s}
      input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(18,37,51,.08)}
      .row2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px}
      .field{margin-bottom:14px}
      .tasas{display:grid;gap:9px}
      .tasa{display:flex;align-items:center;justify-content:space-between;gap:12px;
            border-bottom:1px solid var(--line);padding:9px 2px}
      .tasa:last-child{border-bottom:0}
      .tasa .lbl{font-weight:600;display:flex;align-items:center;gap:9px}
      .tasa.bolivia .lbl{color:var(--pos)}
      .flag{font-size:17px}
      .cur{color:var(--muted);font-size:11px;font-weight:500}
      .tasa .val{text-align:right}
      .tasa .val b{font-size:16px;font-variant-numeric:tabular-nums}
      .tasa.bolivia .val b{color:var(--pos)}
      .tasa .val .sub{display:block;font-size:10.5px;color:var(--muted);font-weight:400}
      .results{display:grid;gap:10px;margin-top:6px}
      .res{display:flex;align-items:center;justify-content:space-between;gap:12px;
           background:var(--field);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
      .res .lbl{font-weight:600;display:flex;align-items:center;gap:9px}
      .res .amt{font-size:19px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--ink)}
      .res.bolivia{background:var(--posbg);border-color:#CDE9E0} .res.bolivia .amt{color:var(--pos)}
      .res .sub{display:block;font-size:11px;color:var(--muted);font-weight:400;text-align:right}
      .refresh{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;text-decoration:none;white-space:nowrap}
      .meta{color:var(--muted);font-size:11.5px;margin:14px 2px 0;text-align:center}
      .error{background:#FBEBEE;border:1px solid #F3C6CF;color:#8A2B3B;padding:14px;border-radius:12px;margin-bottom:16px}
      code{word-break:break-all}
    </style></head><body>
    <div class="wrap">
      <header>
        <div class="logo">${LOGO_SVG || '<strong>AV Finance</strong>'}</div>
        <div class="sub">Conversor de tasas<br>Chile → LatAm</div>
      </header>

      ${aviso}

      <div class="card">
        <h2>Precios USDT · Chile → Bolivia (manual)</h2>
        <p class="hint">La tasa CLP→BOB se arma con la <b>compra de USDT en CLP</b> y la <b>venta de USDT en BOB</b> (no es Vita).</p>
        <div class="row2">
          <div>
            <label for="compra">Compra USDT — CLP por 1 USDT</label>
            <input id="compra" type="text" inputmode="decimal" placeholder="Ej: 950" value="950">
          </div>
          <div>
            <label for="venta">Venta USDT — BOB por 1 USDT</label>
            <input id="venta" type="text" inputmode="decimal" placeholder="Ej: 12,5" value="12,5">
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Tasas · 1 CLP =</h2>
        <p class="hint">Vita con 2% de ganancia (CO/PE/VE) + Chile→Bolivia manual.</p>
        <div class="tasas" id="tasas"></div>
        <p class="meta">Tasa Vita válida hasta <strong>${validUntil ?? '—'}</strong> · <a class="refresh" href="/">↻ Actualizar</a></p>
      </div>

      <div class="card">
        <h2>Conversor — monto en pesos chilenos</h2>
        <p class="hint">Ingresá el monto en CLP y mirá cuánto recibe el destino.</p>
        <div class="field">
          <label for="clp">Monto en CLP</label>
          <input id="clp" type="text" inputmode="numeric" placeholder="Ej: 100.000" value="100000">
        </div>
        <div class="results" id="results"></div>
      </div>
    </div>

    <script>
      const RATES = ${ratesJson};   // [{code,nombre,moneda,flag,dec,base,rate}]  rate = 1 CLP → destino (con 2%)
      const $ = (id) => document.getElementById(id);
      const num = (s) => { const n = parseFloat(String(s).replace(/\\./g,'').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
      const fmt = (n, d) => Number.isFinite(n) ? n.toLocaleString('es-CL', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—';
      const fmtR = (n) => Number.isFinite(n) ? n.toLocaleString('es-CL', { maximumFractionDigits: 6 }) : '—';

      function render() {
        const clp = num($('clp').value);
        const compra = num($('compra').value);   // CLP por USDT
        const venta  = num($('venta').value);    // BOB por USDT
        const tasaBob = compra > 0 ? venta / compra : 0;   // 1 CLP = X BOB

        // ── Tasas (arriba) ──
        let t = '';
        for (const r of RATES) {
          t += \`<div class="tasa"><span class="lbl"><span class="flag">\${r.flag}</span>\${r.nombre} <span class="cur">\${r.moneda}</span></span>
                  <span class="val"><b>\${fmtR(r.rate)} \${r.moneda}</b><span class="sub">Vita cruda \${fmtR(r.base)} · −2%</span></span></div>\`;
        }
        t += \`<div class="tasa bolivia"><span class="lbl"><span class="flag">🇧🇴</span>Bolivia <span class="cur">BOB</span></span>
                <span class="val"><b>\${fmtR(tasaBob)} BOB</b><span class="sub">manual · 1 USDT = \${fmt(compra,2)} CLP → \${fmt(venta,2)} BOB · 1 BOB = \${fmt(tasaBob>0?1/tasaBob:0,2)} CLP</span></span></div>\`;
        $('tasas').innerHTML = t;

        // ── Conversor (abajo) ──
        let html = '';
        for (const r of RATES) {
          html += \`<div class="res"><span class="lbl"><span class="flag">\${r.flag}</span>\${r.nombre} <span class="cur">\${r.moneda}</span></span>
                    <span class="amt">\${fmt(clp * r.rate, r.dec)} <span class="cur">\${r.moneda}</span></span></div>\`;
        }
        const usdt = compra > 0 ? clp / compra : 0;
        html += \`<div class="res bolivia"><span class="lbl"><span class="flag">🇧🇴</span>Bolivia <span class="cur">BOB</span></span>
                  <span style="text-align:right"><span class="amt">\${fmt(usdt * venta, 2)} <span class="cur">BOB</span></span>
                  <span class="sub">\${fmt(usdt, 2)} USDT</span></span></div>\`;
        $('results').innerHTML = html;

        try { localStorage.setItem('usdt', JSON.stringify({ compra: $('compra').value, venta: $('venta').value })); } catch {}
      }
      try { const s = JSON.parse(localStorage.getItem('usdt')||'null'); if (s) { $('compra').value = s.compra; $('venta').value = s.venta; } } catch {}
      ['clp','compra','venta'].forEach(id => $(id).addEventListener('input', render));
      render();
    </script>
  </body></html>`;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  if (req.url === '/logo.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' }); res.end(LOGO_SVG); return; }
  try {
    const data = await getVitaRates();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page(data));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page({ rates: [] }, err.message));
  }
});

server.listen(PORT, () => console.log(`[tasas-vita] Página local en http://localhost:${PORT}`));
