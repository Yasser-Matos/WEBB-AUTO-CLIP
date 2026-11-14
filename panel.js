// =====================================================================
// PANEL DE ADMINISTRACIÓN (rutas del servidor)
//
// Se entra en  https://TU-DIRECCION/admin  con la clave ADMIN_KEY que pusiste en Railway.
// Desde ahí: ver ventas y usuarios, regalar o sumar días, bloquear cuentas,
// cambiar precios y límites de los planes, y revisar que todo esté bien configurado.
// =====================================================================
const path = require('path');
const C = require('./config');
const DB = require('./db');
const U = require('./utiles');

const env = process.env;
const REGEX_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const METODOS_MANUALES = ['efectivo', 'transferencia', 'otro'];   // cobros que anotas tú a mano

// ---------- Validaciones (funciones puras: se pueden probar sin servidor) ----------
const entero = (v, min, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

// Revisa los cambios que llegan para UN plan. Devuelve { campos } o { error }.
function validarPlan(id, cuerpo) {
  const plan = C.PLANES[id];
  if (!plan) return { error: 'Ese plan no existe' };
  const b = cuerpo || {};
  const campos = {};

  if ('nombre' in b) {
    const nombre = String(b.nombre).trim();
    if (!nombre || nombre.length > 30) return { error: 'El nombre debe tener entre 1 y 30 letras' };
    campos.nombre = nombre;
  }
  if ('precioUSD' in b && !plan.esPrueba) {
    const p = Number(b.precioUSD);
    if (!Number.isFinite(p) || p < 0.5 || p > 10000) return { error: 'El precio debe estar entre $0.50 y $10,000' };
    campos.precioUSD = Math.round(p * 100) / 100;
  }
  if ('videosPorMes' in b) {
    const n = entero(b.videosPorMes, 1, 100000);
    if (n === null) return { error: 'Los videos permitidos deben ser un número entero (mínimo 1)' };
    campos.videosPorMes = n;
  }
  if ('maxClips' in b) {
    const n = entero(b.maxClips, 1, C.MAX_CLIPS);
    if (n === null) return { error: `Los clips por video deben estar entre 1 y ${C.MAX_CLIPS}` };
    campos.maxClips = n;
  }
  if ('maxDuracion' in b) {
    const n = entero(b.maxDuracion, 3, C.MAX_DURACION_CLIP);
    if (n === null) return { error: `Los segundos por clip deben estar entre 3 y ${C.MAX_DURACION_CLIP}` };
    campos.maxDuracion = n;
  }
  for (const k of ['logo', 'publicar']) {
    if (k in b) {
      if (typeof b[k] !== 'boolean') return { error: 'Valor no válido' };
      campos[k] = b[k];
    }
  }
  if (!Object.keys(campos).length) return { error: 'No hay nada que guardar' };
  return { campos };
}

// Ejecuta una acción sobre un usuario. Devuelve { mensaje, ... } o { error }.
function ejecutarAccion(usuario, accion, valor, bcrypt) {
  switch (accion) {
    case 'bloquear':
      DB.bloquearUsuario(usuario.id, true);
      return { mensaje: 'Cuenta bloqueada. No podrá entrar hasta que la desbloquees.' };
    case 'desbloquear':
      DB.bloquearUsuario(usuario.id, false);
      return { mensaje: 'Cuenta desbloqueada.' };
    case 'sumar_dias': {
      const dias = entero(valor, 1, 3650);
      if (dias === null) return { error: 'Escribe cuántos días sumar (entre 1 y 3650)' };
      return { mensaje: `Listo: se sumaron ${dias} días.`, vence: DB.sumarDiasUsuario(usuario.id, dias) };
    }
    case 'cambiar_plan':
      if (!C.PLANES[valor]) return { error: 'Ese plan no existe' };
      DB.cambiarPlanUsuario(usuario.id, valor);
      return { mensaje: `Plan cambiado a ${C.PLANES[valor].nombre}.` };
    case 'cambiar_clave': {
      const clave = String(valor || '');
      if (clave.length < 6 || clave.length > 100) return { error: 'La contraseña debe tener al menos 6 caracteres' };
      DB.cambiarClaveUsuario(usuario.id, bcrypt.hashSync(clave, 10));
      return { mensaje: 'Contraseña cambiada.' };
    }
    case 'reiniciar_uso':
      DB.reiniciarUsoUsuario(usuario.id);
      return { mensaje: 'Se reinició el conteo de videos.' };
    case 'cambiar_email': {
      const correo = String(valor || '').toLowerCase().trim();
      if (!REGEX_EMAIL.test(correo)) return { error: 'Escribe un correo válido' };
      if (!DB.cambiarEmailUsuario(usuario.id, correo)) return { error: 'Ese correo ya pertenece a otra cuenta' };
      return { mensaje: 'Correo actualizado.' };
    }
    case 'fijar_vence': {
      const f = String(valor || '');
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(f + 'T00:00:00Z')) &&
        f >= '2020-01-01' && f <= DB.sumarDias(DB.hoy(), 3650);
      if (!ok) return { error: 'Elige una fecha válida' };
      DB.fijarVenceUsuario(usuario.id, f);
      return { mensaje: `El acceso ahora vence el ${f}.`, vence: f };
    }
    // Cobro en efectivo/transferencia: anota el dinero y renueva el acceso
    case 'registrar_cobro': {
      const v = valor || {};
      const plan = C.PLANES[v.plan];
      if (!plan || plan.esPrueba) return { error: 'Elige un plan de pago' };
      const dias = entero(v.dias, 1, 3650);
      if (dias === null) return { error: 'Los días deben ser un número entre 1 y 3650' };
      const monto = Math.round(Number(v.monto) * 100) / 100;
      if (!Number.isFinite(monto) || monto <= 0 || monto > 100000) return { error: 'Escribe cuánto te pagaron (mayor que 0)' };
      if (!METODOS_MANUALES.includes(v.metodo)) return { error: 'Elige cómo te pagaron' };
      const r = DB.registrarCobroManual(usuario, { plan: v.plan, dias, monto, metodo: v.metodo });
      return { mensaje: `Cobro de $${monto.toFixed(2)} anotado. El acceso vence el ${r.vence}.`, vence: r.vence };
    }
    default:
      return { error: 'Acción desconocida' };
  }
}

// ---------- Revisión del sistema (lista de "¿está todo bien configurado?") ----------
// Devuelve una lista de puntos con estado: ok, aviso, falta u opcional.
function revisarSistema({ ffmpeg, ytdlp }) {
  const puntos = [];
  const add = (id, titulo, estado, detalle) => puntos.push({ id, titulo, estado, detalle });

  add('jwt', 'Clave secreta de sesiones', C.JWT_SECRET !== 'cambia-esta-clave-larga' ? 'ok' : 'falta',
    C.JWT_SECRET !== 'cambia-esta-clave-larga' ? 'Configurada.'
      : 'Agrega la variable JWT_SECRET en Railway con una frase larga inventada por ti. Sin ella, la seguridad de las sesiones es débil.');

  const dentroDelProyecto = C.DB_PATH !== ':memory:' && path.resolve(C.DB_PATH).startsWith(path.resolve(__dirname));
  add('db', 'Base de datos protegida', dentroDelProyecto ? 'aviso' : 'ok',
    dentroDelProyecto
      ? 'Tu base de datos está dentro del proyecto: en Railway se borraría con cada actualización. Crea un Volume en /data y pon la variable DB_PATH = /data/data.db.'
      : 'Los usuarios y pagos se guardan fuera del proyecto.');

  add('url', 'Dirección pública', env.URL_PUBLICA ? 'ok' : 'aviso',
    env.URL_PUBLICA ? env.URL_PUBLICA : 'Agrega la variable URL_PUBLICA (por ejemplo https://tuapp.up.railway.app) para que los enlaces de pago y de redes sociales siempre sean correctos.');

  const stripeKey = !!env.STRIPE_SECRET_KEY, stripeHook = !!env.STRIPE_WEBHOOK_SECRET;
  add('stripe', 'Cobro con tarjeta (Stripe)', stripeKey && stripeHook ? 'ok' : stripeKey ? 'falta' : 'opcional',
    stripeKey && stripeHook ? 'Listo para cobrar.'
      : stripeKey ? 'Falta STRIPE_WEBHOOK_SECRET: sin él, los pagos se cobran pero el acceso no se activa solo.'
        : 'Sin configurar. Si no la usas, no pasa nada.');

  const ppOk = !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
  add('paypal', 'Cobro con PayPal', ppOk ? (env.PAYPAL_MODO === 'live' ? 'ok' : 'aviso') : 'opcional',
    ppOk ? (env.PAYPAL_MODO === 'live' ? 'Listo para cobrar.' : 'Está en modo de PRUEBA: no cobra de verdad. Cuando quieras vender, pon PAYPAL_MODO = live.')
      : 'Sin configurar. Si no la usas, no pasa nada.');

  const redes = [
    ['youtube', 'YouTube', env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET],
    ['tiktok', 'TikTok', env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET],
    ['instagram', 'Instagram', env.META_APP_ID && env.META_APP_SECRET],
  ];
  for (const [id, nombre, ok] of redes) {
    add(id, `Publicar en ${nombre}`, ok ? 'ok' : 'opcional', ok ? 'Configurado.' : 'Sin configurar. Solo se muestra a tus clientes si lo configuras.');
  }

  add('ffmpeg', 'Programa que corta los videos (ffmpeg)', ffmpeg ? 'ok' : 'falta',
    ffmpeg ? 'Instalado.' : 'No se encuentra. Revisa que el archivo nixpacks.toml esté en tu proyecto.');
  add('ytdlp', 'Descargar videos desde un link (yt-dlp)', ytdlp ? 'ok' : 'aviso',
    ytdlp ? 'Instalado.' : 'No se encuentra: los clientes podrán subir archivos, pero no pegar links. Revisa nixpacks.toml.');
  return puntos;
}

// Comprueba si ffmpeg y yt-dlp existen (se guarda el resultado 1 minuto para no repetirlo)
let cacheHerramientas = { hasta: 0, valor: null };
async function herramientas() {
  if (cacheHerramientas.valor && cacheHerramientas.hasta > Date.now()) return cacheHerramientas.valor;
  const existe = cmd => U.ejecutar(cmd, [cmd === 'ffmpeg' ? '-version' : '--version'], { timeoutMs: 8000 }).then(() => true, () => false);
  const [ffmpeg, ytdlp] = await Promise.all([existe('ffmpeg'), existe('yt-dlp')]);
  cacheHerramientas = { hasta: Date.now() + 60000, valor: { ffmpeg, ytdlp } };
  return cacheHerramientas.valor;
}

// ---------- Rutas ----------
function montar(app, { jwt, bcrypt, estadoServidor }) {
  // La sesión del administrador es una cookie aparte (8 horas) y "estricta": otras páginas no pueden usarla
  const SECRETO = C.JWT_SECRET + ':admin';
  const opcionesCookie = { httpOnly: true, sameSite: 'strict', secure: env.NODE_ENV === 'production', maxAge: 8 * 3600 * 1000 };
  const esAdmin = req => { try { return jwt.verify(req.cookies.admin, SECRETO).rol === 'admin'; } catch { return false; } };
  const requiereAdmin = (req, res, next) =>
    esAdmin(req) ? next() : res.status(401).json({ error: 'Entra al panel con tu clave de administrador' });

  // La página del panel
  app.get('/admin', (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');       // que Google no la muestre
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });

  app.post('/api/admin/login', U.limitador(8, 10 * 60 * 1000), (req, res) => {
    if (!C.ADMIN_KEY) return res.status(503).json({ error: 'Todavía no configuraste ADMIN_KEY en las Variables de Railway.' });
    if (!U.igualesSeguros(String((req.body || {}).clave || ''), C.ADMIN_KEY)) return res.status(403).json({ error: 'Esa clave no es correcta' });
    res.cookie('admin', jwt.sign({ rol: 'admin' }, SECRETO, { expiresIn: '8h' }), opcionesCookie);
    res.json({ ok: true });
  });
  app.post('/api/admin/logout', (req, res) => { res.clearCookie('admin'); res.json({ ok: true }); });
  app.get('/api/admin/sesion', requiereAdmin, (req, res) => res.json({ ok: true }));

  // Inicio: ventas, usuarios y avisos
  app.get('/api/admin/resumen', requiereAdmin, async (req, res) => {
    const sistema = revisarSistema(await herramientas());
    res.json({
      ...DB.resumen(),
      planes: Object.fromEntries(Object.entries(C.PLANES).map(([id, p]) => [id, { nombre: p.nombre, precioUSD: p.precioUSD }])),
      porConfigurar: sistema.filter(p => p.estado === 'falta').length,
    });
  });

  // Lista de usuarios con búsqueda y filtros
  app.get('/api/admin/usuarios', requiereAdmin, (req, res) => {
    const estado = ['activo', 'prueba', 'vencido', 'bloqueado'].includes(req.query.estado) ? req.query.estado : '';
    const plan = C.PLANES[req.query.plan] ? req.query.plan : '';
    res.json(DB.listarUsuarios({ q: String(req.query.q || '').slice(0, 100), estado, plan, pagina: req.query.pagina }));
  });

  // Crear un usuario (o renovarlo con nueva contraseña). También acepta la "clave" en el cuerpo, como antes.
  app.post('/api/admin/usuario', U.limitador(60, 10 * 60 * 1000),
    (req, res, next) => {
      if (esAdmin(req) || (C.ADMIN_KEY && U.igualesSeguros(String((req.body || {}).clave || ''), C.ADMIN_KEY))) return next();
      res.status(403).json({ error: 'Clave de admin incorrecta' });
    },
    (req, res) => {
      const { email, password, dias, plan } = req.body || {};
      const correo = String(email || '').toLowerCase().trim();
      if (!REGEX_EMAIL.test(correo)) return res.status(400).json({ error: 'Escribe un correo válido' });
      if (String(password || '').length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      const d = entero(dias, 1, 3650);
      if (d === null) return res.status(400).json({ error: 'Los días deben ser un número entre 1 y 3650' });
      const planId = plan || C.PLAN_POR_DEFECTO;
      if (!C.PLANES[planId]) return res.status(400).json({ error: 'Ese plan no existe' });
      // Si ya te pagaron (efectivo, transferencia...), se puede anotar el cobro de una vez
      const { monto, metodo } = req.body || {};
      const cobro = monto === undefined || monto === '' || monto === null ? 0 : Math.round(Number(monto) * 100) / 100;
      if (!Number.isFinite(cobro) || cobro < 0 || cobro > 100000) return res.status(400).json({ error: 'El monto cobrado no es válido' });
      if (cobro > 0 && !METODOS_MANUALES.includes(metodo)) return res.status(400).json({ error: 'Elige cómo te pagaron' });

      const existente = DB.usuarioPorEmail(correo);
      const vence = DB.sumarDias(DB.hoy(), d);
      const hash = bcrypt.hashSync(String(password), 10);
      DB.db.prepare(`
        INSERT INTO usuarios (email, hash, vence, plan) VALUES (?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET hash = excluded.hash, vence = excluded.vence, plan = excluded.plan, activo = 1
      `).run(correo, hash, vence, planId);
      if (cobro > 0) DB.anotarPagoManual({ email: correo, hash, plan: planId, monto: cobro, metodo });
      res.json({ ok: true, email: correo, vence, plan: planId, creado: !existente, cobro });
    });

  // Acciones sobre un usuario: bloquear, sumar días, cambiar plan o contraseña, reiniciar uso
  app.post('/api/admin/usuarios/:id/accion', requiereAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const usuario = DB.usuarioPorId(id);
    if (!usuario) return res.status(404).json({ error: 'Ese usuario ya no existe' });
    const r = ejecutarAccion(usuario, (req.body || {}).accion, (req.body || {}).valor, bcrypt);
    if (r.error) return res.status(400).json(r);
    // Devolvemos la fila ya actualizada (si cambió el correo, también sale nuevo)
    res.json({ ok: true, ...r, usuario: DB.listarUsuarios({ id }).usuarios[0] });
  });

  app.delete('/api/admin/usuarios/:id', requiereAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!DB.usuarioPorId(id)) return res.status(404).json({ error: 'Ese usuario ya no existe' });
    DB.borrarUsuario(id);
    res.json({ ok: true });
  });

  app.get('/api/admin/pagos', requiereAdmin, (req, res) => res.json({ pagos: DB.listarPagos(100) }));

  // Planes y precios
  app.get('/api/admin/planes', requiereAdmin, (req, res) => {
    res.json({
      planes: Object.fromEntries(Object.entries(C.PLANES).map(([id, p]) => [id, { ...p }])),
      prueba: { ...C.PRUEBA },
      diasPorCompra: C.DIAS_POR_COMPRA,
      maximos: { clips: C.MAX_CLIPS, duracion: C.MAX_DURACION_CLIP },
    });
  });
  app.put('/api/admin/planes/:id', requiereAdmin, (req, res) => {
    const r = validarPlan(req.params.id, req.body);
    if (r.error) return res.status(400).json(r);
    DB.guardarPlan(req.params.id, r.campos);
    res.json({ ok: true, plan: { ...C.PLANES[req.params.id] } });
  });
  app.put('/api/admin/prueba', requiereAdmin, (req, res) => {
    const b = req.body || {}, campos = {};
    if ('activa' in b) { if (typeof b.activa !== 'boolean') return res.status(400).json({ error: 'Valor no válido' }); campos.activa = b.activa; }
    if ('dias' in b) {
      const d = entero(b.dias, 1, 90);
      if (d === null) return res.status(400).json({ error: 'Los días de prueba deben estar entre 1 y 90' });
      campos.dias = d;
    }
    if (!Object.keys(campos).length) return res.status(400).json({ error: 'No hay nada que guardar' });
    DB.guardarPrueba(campos);
    res.json({ ok: true, prueba: { ...C.PRUEBA } });
  });

  // Estado del sistema
  app.get('/api/admin/sistema', requiereAdmin, async (req, res) => {
    res.json({
      puntos: revisarSistema(await herramientas()),
      servidor: {
        ...estadoServidor(),
        encendidoHace: Math.round(process.uptime()),
        memoriaMB: Math.round(process.memoryUsage().rss / 1048576),
        node: process.version,
      },
    });
  });
}

module.exports = { montar, validarPlan, ejecutarAccion, revisarSistema };
