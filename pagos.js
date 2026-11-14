// =====================================================================
// PAGOS AUTOMÁTICOS (Stripe y PayPal)
//
// Flujo: la persona escribe correo + contraseña + plan -> la mandamos a pagar ->
// cuando Stripe/PayPal AVISAN que el pago salió bien, el acceso se crea solo.
// Nada de esto usa librerías: solo "fetch" (viene con Node 18+).
//
// Variables que pones en Railway (solo las del método que quieras usar):
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_MODO (pon "live" para cobrar de verdad)
// =====================================================================
const crypto = require('crypto');
const C = require('./config');
const DB = require('./db');
const { baseUrl, igualesSeguros, limitador } = require('./utiles');

const env = process.env;
const centavos = plan => Math.round(plan.precioUSD * 100);
// Planes que se pueden comprar (la prueba gratis no se vende)
const planesVenta = () => Object.entries(C.PLANES).filter(([, p]) => !p.esPrueba);

function proveedoresActivos() {
  const lista = [];
  if (env.STRIPE_SECRET_KEY) lista.push('stripe');
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) lista.push('paypal');
  return lista;
}

// ---------- Confirmar un pago (lo usan Stripe y PayPal) ----------
// Revisa que el monto coincida con el precio del plan y activa el acceso UNA sola vez.
function confirmarPago(pagoId, centavosPagados) {
  const pago = DB.obtenerPago(pagoId);
  if (!pago) return false;
  const plan = C.PLANES[pago.plan];
  // Se compara con el monto guardado al crear el pago (así un cambio de precio no rompe pagos en curso)
  const esperado = pago.monto > 0 ? Math.round(pago.monto * 100) : (plan ? centavos(plan) : -1);
  if (!plan || plan.esPrueba || centavosPagados !== esperado) {
    console.error(`[pagos] Monto distinto al esperado en el pago ${pagoId}: ${centavosPagados}`);
    return false;
  }
  if (!DB.marcarPagado(pagoId)) return true;          // ya estaba procesado
  DB.activarAcceso({ email: pago.email, hash: pago.hash, plan: pago.plan });
  return true;
}

// ---------- STRIPE ----------
// Comprueba que el aviso realmente viene de Stripe (firma HMAC) y no es falso.
function verificarFirmaStripe(cuerpoCrudo, cabecera, secreto, ahora = Date.now() / 1000, tolerancia = 300) {
  if (!cabecera || !secreto) return false;
  let t = null; const firmas = [];
  for (const parte of String(cabecera).split(',')) {
    const [k, v] = parte.split('=');
    if (k === 't') t = v; else if (k === 'v1') firmas.push(v);
  }
  if (!t || !firmas.length || Math.abs(ahora - Number(t)) > tolerancia) return false;
  const esperado = crypto.createHmac('sha256', secreto).update(`${t}.`).update(cuerpoCrudo).digest('hex');
  return firmas.some(f => igualesSeguros(f, esperado));
}

async function stripeCrearSesion(pago, plan, base) {
  const f = new URLSearchParams();
  f.set('mode', 'payment');
  f.set('client_reference_id', pago.id);
  f.set('customer_email', pago.email);
  f.set('success_url', `${base}/?pago=ok`);
  f.set('cancel_url', `${base}/?pago=cancelado`);
  f.set('line_items[0][quantity]', '1');
  f.set('line_items[0][price_data][currency]', 'usd');
  f.set('line_items[0][price_data][unit_amount]', String(centavos(plan)));
  f.set('line_items[0][price_data][product_data][name]', `VideoClips ${plan.nombre} - ${C.DIAS_POR_COMPRA} días`);
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: f,
  });
  const j = await r.json();
  if (!r.ok || !j.url) throw new Error((j.error && j.error.message) || 'Stripe no respondió');
  return j.url;
}

// ---------- PAYPAL ----------
const paypalApi = () => env.PAYPAL_MODO === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

async function paypalToken() {
  const r = await fetch(`${paypalApi()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json();
  if (!r.ok) throw new Error('PayPal no respondió');
  return j.access_token;
}

async function paypalCrearOrden(pago, plan, base) {
  const token = await paypalToken();
  const r = await fetch(`${paypalApi()}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: pago.id,
        description: `VideoClips ${plan.nombre} - ${C.DIAS_POR_COMPRA} días`,
        amount: { currency_code: 'USD', value: plan.precioUSD.toFixed(2) },
      }],
      payment_source: { paypal: { experience_context: {
        return_url: `${base}/api/pago/paypal/retorno?pago=${pago.id}`,
        cancel_url: `${base}/?pago=cancelado`,
        user_action: 'PAY_NOW',
      } } },
    }),
  });
  const j = await r.json();
  const enlace = (j.links || []).find(l => l.rel === 'payer-action' || l.rel === 'approve');
  if (!r.ok || !enlace) throw new Error('PayPal no creó la orden');
  return { url: enlace.href, orden: j.id };
}

async function paypalCapturar(ordenId) {
  const token = await paypalToken();
  const r = await fetch(`${paypalApi()}/v2/checkout/orders/${encodeURIComponent(ordenId)}/capture`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  const j = await r.json();
  const cap = j.purchase_units && j.purchase_units[0] && j.purchase_units[0].payments &&
              j.purchase_units[0].payments.captures && j.purchase_units[0].payments.captures[0];
  if (!r.ok || j.status !== 'COMPLETED' || !cap || cap.amount.currency_code !== 'USD') return null;
  return Math.round(parseFloat(cap.amount.value) * 100);
}

// ---------- RUTAS ----------
// 1) El aviso de Stripe necesita el cuerpo "crudo", por eso se monta ANTES de express.json()
function montarWebhook(app, express) {
  app.post('/api/pago/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    if (!verificarFirmaStripe(req.body, req.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET)) {
      return res.status(400).send('firma inválida');
    }
    let ev;
    try { ev = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).end(); }
    const o = ev.data && ev.data.object;
    if (o && (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') &&
        o.payment_status === 'paid') {
      confirmarPago(o.client_reference_id, o.currency === 'usd' ? o.amount_total : -1);
    }
    res.json({ recibido: true });
  });
}

// 2) Las demás rutas (ya con JSON activado)
function montar(app, { bcrypt }) {
  // Lista pública de planes (para mostrar la pantalla de compra)
  app.get('/api/planes', (req, res) => {
    res.json({
      dias: C.DIAS_POR_COMPRA,
      proveedores: proveedoresActivos(),
      planes: planesVenta().map(([id, p]) => ({ id, ...p })),
      // Datos de la prueba gratis (la web muestra la pestaña solo si está activa)
      prueba: C.PRUEBA.activa ? { dias: C.PRUEBA.dias, ...C.PLANES.prueba } : null,
    });
  });

  // Empieza una compra (o renovación)
  app.post('/api/pago/crear', limitador(15, 10 * 60 * 1000), async (req, res) => {
    try {
      const { email, password, plan, proveedor } = req.body || {};
      const correo = String(email || '').toLowerCase().trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) return res.status(400).json({ error: 'Escribe un correo válido' });
      if (String(password || '').length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      const p = C.PLANES[plan];
      if (!p || p.esPrueba) return res.status(400).json({ error: 'Plan no válido' });
      if (!proveedoresActivos().includes(proveedor)) return res.status(400).json({ error: 'Método de pago no disponible' });

      // Si el correo ya tiene cuenta, la contraseña debe ser la suya (así nadie le cambia la clave a otro)
      const existente = DB.usuarioPorEmail(correo);
      if (existente && !bcrypt.compareSync(String(password), existente.hash)) {
        return res.status(400).json({ error: 'Ese correo ya tiene cuenta. Para renovar escribe tu contraseña actual.' });
      }

      const pago = {
        id: crypto.randomBytes(12).toString('hex'), email: correo, plan, proveedor, monto: p.precioUSD,
        hash: existente ? existente.hash : bcrypt.hashSync(String(password), 10),
      };
      DB.crearPago(pago);
      const base = baseUrl(req);
      if (proveedor === 'stripe') return res.json({ url: await stripeCrearSesion(pago, p, base) });
      const orden = await paypalCrearOrden(pago, p, base);
      DB.guardarReferencia(pago.id, orden.orden);
      res.json({ url: orden.url });
    } catch (e) {
      console.error('[pagos]', e.message);
      res.status(502).json({ error: 'No se pudo iniciar el pago. Intenta de nuevo.' });
    }
  });

  // PayPal te devuelve aquí después de aprobar; aquí se cobra de verdad
  app.get('/api/pago/paypal/retorno', async (req, res) => {
    try {
      const pago = DB.obtenerPago(String(req.query.pago || ''));
      if (!pago || pago.proveedor !== 'paypal' || pago.referencia !== String(req.query.token || '')) return res.redirect('/?pago=error');
      const cobrado = await paypalCapturar(pago.referencia);
      if (cobrado === null || !confirmarPago(pago.id, cobrado)) return res.redirect('/?pago=error');
      res.redirect('/?pago=ok');
    } catch (e) {
      console.error('[pagos]', e.message);
      res.redirect('/?pago=error');
    }
  });
}

module.exports = { montarWebhook, montar, verificarFirmaStripe, confirmarPago, proveedoresActivos };
