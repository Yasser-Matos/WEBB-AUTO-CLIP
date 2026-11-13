// =====================================================================
// BASE DE DATOS (SQLite) - usuarios, uso mensual, pagos, pruebas y ajustes
// OJO: aquí NUNCA se guardan videos, solo datos de las cuentas.
// =====================================================================
const crypto = require('crypto');
const Database = require('better-sqlite3');
const C = require('./config');

const db = new Database(C.DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    hash TEXT NOT NULL,
    activo INTEGER NOT NULL DEFAULT 1,   -- 1 = puede entrar, 0 = bloqueado
    vence TEXT NOT NULL,                 -- fecha AAAA-MM-DD en que se acaba su acceso
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Cuántos videos procesó cada usuario en cada mes (para los límites del plan)
  CREATE TABLE IF NOT EXISTS uso (
    usuario_id INTEGER NOT NULL,
    mes TEXT NOT NULL,                   -- AAAA-MM
    videos INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (usuario_id, mes)
  );
  -- Compras: nacen "pendiente" y pasan a "pagado" cuando Stripe/PayPal confirman
  CREATE TABLE IF NOT EXISTS pagos (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    hash TEXT NOT NULL,                  -- contraseña ya cifrada
    plan TEXT NOT NULL,
    proveedor TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    referencia TEXT,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Permisos de redes sociales (el token va cifrado)
  CREATE TABLE IF NOT EXISTS redes (
    usuario_id INTEGER NOT NULL,
    red TEXT NOT NULL,
    datos TEXT NOT NULL,
    nombre TEXT,
    PRIMARY KEY (usuario_id, red)
  );
  -- Pruebas gratis ya entregadas (una por persona, aunque borres la cuenta)
  CREATE TABLE IF NOT EXISTS pruebas (
    clave TEXT PRIMARY KEY,              -- correo "normalizado" (sin puntos ni +alias de Gmail)
    ip TEXT NOT NULL,                    -- conexión (cifrada, no se guarda la IP real)
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Ajustes que cambias desde el panel (precios, límites, prueba)
  CREATE TABLE IF NOT EXISTS ajustes (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
`);

// ---------- Migraciones: bases de versiones anteriores reciben las columnas nuevas ----------
function agregarColumna(tabla, columna, definicion) {
  const existentes = db.prepare(`PRAGMA table_info(${tabla})`).all().map(c => c.name);
  if (!existentes.includes(columna)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
}
agregarColumna('usuarios', 'plan', `TEXT NOT NULL DEFAULT '${C.PLAN_POR_DEFECTO}'`);
agregarColumna('pagos', 'monto', 'REAL NOT NULL DEFAULT 0');       // lo que costó al comprar
agregarColumna('pagos', 'pagado_en', 'TEXT');                       // cuándo se confirmó

// ---------- Fechas ----------
const hoy = () => new Date().toISOString().slice(0, 10);
const mesActual = () => new Date().toISOString().slice(0, 7);
function sumarDias(fecha, dias) {
  return new Date(Date.parse(fecha + 'T00:00:00Z') + dias * 86400000).toISOString().slice(0, 10);
}
function diasEntre(desde, hasta) {           // días desde "desde" hasta "hasta" (negativo si ya pasó)
  return Math.round((Date.parse(hasta + 'T00:00:00Z') - Date.parse(desde + 'T00:00:00Z')) / 86400000);
}
function ultimosMeses(n) {                    // ['2026-06', ..., '2026-11'] (el último es el mes actual)
  const [a, m] = mesActual().split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(a, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

// ---------- Usuarios y planes ----------
const usuarioPorId = id => db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
const usuarioPorEmail = email => db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);

// Devuelve la configuración del plan del usuario (si el plan ya no existe, usa el básico)
function planDe(usuario) {
  return C.PLANES[usuario.plan] || C.PLANES[C.PLAN_POR_DEFECTO];
}

// Crea el usuario o le renueva el acceso. Si todavía le quedan días de un plan pagado, los nuevos se SUMAN.
// (Los días que sobren de la prueba gratis no se suman: al comprar, el conteo empieza hoy.)
function activarAcceso({ email, hash, plan, dias = C.DIAS_POR_COMPRA }) {
  const u = usuarioPorEmail(email);
  const base = u && u.vence > hoy() && u.plan !== 'prueba' ? u.vence : hoy();
  const vence = sumarDias(base, dias);
  if (u) {
    db.prepare('UPDATE usuarios SET plan = ?, vence = ?, activo = 1 WHERE id = ?').run(plan, vence, u.id);
  } else {
    db.prepare('INSERT INTO usuarios (email, hash, vence, plan) VALUES (?, ?, ?, ?)').run(email, hash, vence, plan);
  }
  return { email, vence, plan };
}

// ---------- Uso ----------
function usoDelMes(usuarioId) {
  const f = db.prepare('SELECT videos FROM uso WHERE usuario_id = ? AND mes = ?').get(usuarioId, mesActual());
  return f ? f.videos : 0;
}
function usoTotal(usuarioId) {
  const f = db.prepare('SELECT COALESCE(SUM(videos), 0) AS n FROM uso WHERE usuario_id = ?').get(usuarioId);
  return Number(f.n);
}
// En la prueba gratis los videos cuentan EN TOTAL; en los planes de pago, por mes.
const usoParaPlan = (usuarioId, plan) => (plan.esPrueba ? usoTotal(usuarioId) : usoDelMes(usuarioId));
function sumarUso(usuarioId, n) {
  db.prepare(`
    INSERT INTO uso (usuario_id, mes, videos) VALUES (?, ?, MAX(0, ?))
    ON CONFLICT(usuario_id, mes) DO UPDATE SET videos = MAX(0, videos + ?)
  `).run(usuarioId, mesActual(), n, n);
}

// ---------- Prueba gratis ----------
// Gmail ignora los puntos y lo que va después de "+": a.b+x@gmail.com es el mismo buzón que ab@gmail.com
function normalizarEmail(email) {
  const [local0, dominio0] = String(email).toLowerCase().trim().split('@');
  let local = (local0 || '').split('+')[0];
  let dominio = dominio0 || '';
  if (dominio === 'googlemail.com') dominio = 'gmail.com';
  if (dominio === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${dominio}`;
}
const huellaIp = ip => crypto.createHash('sha256').update(`${ip}|${C.JWT_SECRET}`).digest('hex').slice(0, 24);

// Crea una cuenta de prueba gratis. Devuelve { usuario } o { error }.
function registrarPrueba({ email, hash, ip }) {
  if (!C.PRUEBA.activa) return { error: 'Las pruebas gratis no están disponibles por ahora. Puedes comprar un plan.' };
  if (usuarioPorEmail(email)) return { error: 'Ese correo ya tiene una cuenta. Entra con tu contraseña.' };
  const clave = normalizarEmail(email);
  if (db.prepare('SELECT 1 FROM pruebas WHERE clave = ?').get(clave)) {
    return { error: 'Ese correo ya usó su prueba gratis. Puedes comprar un plan para seguir.' };
  }
  const huella = huellaIp(ip);
  const recientes = db.prepare(`SELECT COUNT(*) AS n FROM pruebas WHERE ip = ? AND creado > datetime('now', '-1 day')`).get(huella);
  if (Number(recientes.n) >= C.MAX_PRUEBAS_POR_IP_DIA) {
    return { error: 'Ya se crearon varias pruebas desde esta conexión hoy. Intenta mañana o compra un plan.' };
  }
  db.prepare('INSERT INTO pruebas (clave, ip) VALUES (?, ?)').run(clave, huella);
  db.prepare('INSERT INTO usuarios (email, hash, vence, plan) VALUES (?, ?, ?, ?)')
    .run(email, hash, sumarDias(hoy(), C.PRUEBA.dias), 'prueba');
  return { usuario: usuarioPorEmail(email) };
}

// ---------- Pagos ----------
function crearPago(p) {
  db.prepare('INSERT INTO pagos (id, email, hash, plan, proveedor, monto) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.id, p.email, p.hash, p.plan, p.proveedor, p.monto || 0);
}
const obtenerPago = id => db.prepare('SELECT * FROM pagos WHERE id = ?').get(id);
function guardarReferencia(id, ref) { db.prepare('UPDATE pagos SET referencia = ? WHERE id = ?').run(ref, id); }
// Pasa de "pendiente" a "pagado" UNA sola vez (evita activar dos veces si llegan dos avisos)
function marcarPagado(id) {
  return db.prepare(`UPDATE pagos SET estado = 'pagado', pagado_en = datetime('now') WHERE id = ? AND estado = 'pendiente'`).run(id).changes === 1;
}

// ---------- Redes sociales ----------
function guardarRed(usuarioId, red, datos, nombre) {
  db.prepare(`
    INSERT INTO redes (usuario_id, red, datos, nombre) VALUES (?, ?, ?, ?)
    ON CONFLICT(usuario_id, red) DO UPDATE SET datos = excluded.datos, nombre = excluded.nombre
  `).run(usuarioId, red, datos, nombre || '');
}
const obtenerRed = (usuarioId, red) => db.prepare('SELECT * FROM redes WHERE usuario_id = ? AND red = ?').get(usuarioId, red);
const listarRedes = usuarioId => db.prepare('SELECT red, nombre FROM redes WHERE usuario_id = ?').all(usuarioId);
const borrarRed = (usuarioId, red) => db.prepare('DELETE FROM redes WHERE usuario_id = ? AND red = ?').run(usuarioId, red);

// ---------- Ajustes editables desde el panel ----------
// Lo que cambias en el panel se guarda aquí y se aplica encima de config.js al arrancar.
const CAMPOS_PLAN = ['nombre', 'precioUSD', 'videosPorMes', 'maxClips', 'maxDuracion', 'logo', 'publicar'];

function leerAjuste(clave) {
  const f = db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(clave);
  if (!f) return null;
  try { return JSON.parse(f.valor); } catch { return null; }
}
function guardarAjuste(clave, valor) {
  db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor')
    .run(clave, JSON.stringify(valor));
}
function aplicarAjustes() {
  const planes = leerAjuste('planes') || {};
  for (const [id, campos] of Object.entries(planes)) {
    if (!C.PLANES[id]) continue;
    for (const k of CAMPOS_PLAN) if (k in campos) C.PLANES[id][k] = campos[k];
  }
  const prueba = leerAjuste('prueba');
  if (prueba) {
    if (typeof prueba.activa === 'boolean') C.PRUEBA.activa = prueba.activa;
    if (Number.isInteger(prueba.dias)) C.PRUEBA.dias = prueba.dias;
  }
}
// Guarda los cambios de UN plan y los aplica al momento
function guardarPlan(id, campos) {
  const todos = leerAjuste('planes') || {};
  todos[id] = { ...(todos[id] || {}), ...campos };
  guardarAjuste('planes', todos);
  aplicarAjustes();
}
function guardarPrueba(campos) {
  guardarAjuste('prueba', { activa: C.PRUEBA.activa, dias: C.PRUEBA.dias, ...campos });
  aplicarAjustes();
}
aplicarAjustes();

// ---------- Consultas para el panel de administración ----------
// Estado "humano" de una cuenta
function estadoUsuario(u) {
  if (!u.activo) return 'bloqueado';
  if (u.vence < hoy()) return 'vencido';
  return u.plan === 'prueba' ? 'prueba' : 'activo';
}

// Condición SQL según el filtro elegido
function filtroEstado(estado) {
  const h = hoy();
  switch (estado) {
    case 'activo': return { sql: `u.activo = 1 AND u.vence >= ? AND u.plan != 'prueba'`, args: [h] };
    case 'prueba': return { sql: `u.activo = 1 AND u.vence >= ? AND u.plan = 'prueba'`, args: [h] };
    case 'vencido': return { sql: `u.activo = 1 AND u.vence < ?`, args: [h] };
    case 'bloqueado': return { sql: `u.activo = 0`, args: [] };
    default: return null;
  }
}

function listarUsuarios({ q = '', estado = '', plan = '', pagina = 1, porPagina = 15, id = null } = {}) {
  const donde = [], args = [];
  if (id) { donde.push('u.id = ?'); args.push(id); }
  if (q) { donde.push(`u.email LIKE ? ESCAPE '\\'`); args.push('%' + String(q).replace(/[\\%_]/g, '\\$&') + '%'); }
  const fe = filtroEstado(estado);
  if (fe) { donde.push(fe.sql); args.push(...fe.args); }
  if (plan) { donde.push('u.plan = ?'); args.push(plan); }
  const where = donde.length ? 'WHERE ' + donde.join(' AND ') : '';
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM usuarios u ${where}`).get(...args).n);
  const pag = Math.max(1, Math.floor(Number(pagina)) || 1);
  const filas = db.prepare(`
    SELECT u.id, u.email, u.plan, u.vence, u.activo, u.creado,
           COALESCE((SELECT videos FROM uso WHERE usuario_id = u.id AND mes = ?), 0) AS usoMes,
           COALESCE((SELECT SUM(videos) FROM uso WHERE usuario_id = u.id), 0) AS usoTotal
    FROM usuarios u ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?
  `).all(mesActual(), ...args, porPagina, (pag - 1) * porPagina);
  return {
    total, pagina: pag, porPagina,
    usuarios: filas.map(u => ({
      id: u.id, email: u.email, plan: u.plan, vence: u.vence, creado: u.creado,
      activo: !!u.activo, estado: estadoUsuario(u), diasRestantes: diasEntre(hoy(), u.vence),
      usoMes: Number(u.usoMes), usoTotal: Number(u.usoTotal),
    })),
  };
}

function listarPagos(limite = 50) {
  return db.prepare(`
    SELECT id, email, plan, proveedor, monto, estado, creado, pagado_en AS pagadoEn
    FROM pagos ORDER BY creado DESC, rowid DESC LIMIT ?
  `).all(limite).map(p => ({ ...p }));
}

// Todo lo que muestra la pantalla de inicio del panel
function resumen() {
  const h = hoy(), mes = mesActual();
  const n = (sql, ...a) => Number(db.prepare(sql).get(...a).n);
  const meses = ultimosMeses(6);
  const ingresosMes = Object.fromEntries(db.prepare(`
    SELECT substr(pagado_en, 1, 7) AS m, SUM(monto) AS t FROM pagos WHERE estado = 'pagado' AND pagado_en IS NOT NULL GROUP BY m
  `).all().map(r => [r.m, Number(r.t)]));
  const registrosMes = Object.fromEntries(db.prepare(`
    SELECT substr(creado, 1, 7) AS m, COUNT(*) AS t FROM usuarios GROUP BY m
  `).all().map(r => [r.m, Number(r.t)]));

  const porPlan = {};
  for (const r of db.prepare(`SELECT plan, COUNT(*) AS n FROM usuarios WHERE activo = 1 AND vence >= ? GROUP BY plan`).all(h)) porPlan[r.plan] = Number(r.n);

  return {
    usuarios: {
      total: n('SELECT COUNT(*) AS n FROM usuarios'),
      activos: n(`SELECT COUNT(*) AS n FROM usuarios WHERE activo = 1 AND vence >= ? AND plan != 'prueba'`, h),
      pruebas: n(`SELECT COUNT(*) AS n FROM usuarios WHERE activo = 1 AND vence >= ? AND plan = 'prueba'`, h),
      vencidos: n('SELECT COUNT(*) AS n FROM usuarios WHERE activo = 1 AND vence < ?', h),
      bloqueados: n('SELECT COUNT(*) AS n FROM usuarios WHERE activo = 0'),
      nuevosSemana: n(`SELECT COUNT(*) AS n FROM usuarios WHERE creado > datetime('now', '-7 day')`),
      // Personas que de verdad usaron la web este mes (procesaron al menos un video)
      usaronEsteMes: n('SELECT COUNT(DISTINCT usuario_id) AS n FROM uso WHERE mes = ? AND videos > 0', mes),
    },
    porPlan,
    ingresos: {
      mes: ingresosMes[mes] || 0,
      total: n(`SELECT COALESCE(SUM(monto), 0) AS n FROM pagos WHERE estado = 'pagado'`),
      pagosMes: n(`SELECT COUNT(*) AS n FROM pagos WHERE estado = 'pagado' AND substr(pagado_en, 1, 7) = ?`, mes),
      cantidad: n(`SELECT COUNT(*) AS n FROM pagos WHERE estado = 'pagado'`),     // ventas cobradas en total
    },
    videosMes: n('SELECT COALESCE(SUM(videos), 0) AS n FROM uso WHERE mes = ?', mes),
    // Las últimas ventas cobradas (la "caja" de la pantalla de inicio)
    ultimasVentas: db.prepare(`
      SELECT email, plan, proveedor, monto, pagado_en AS pagadoEn FROM pagos
      WHERE estado = 'pagado' ORDER BY pagado_en DESC, rowid DESC LIMIT 6
    `).all().map(v => ({ ...v })),
    mensual: meses.map(m => ({ mes: m, ingresos: ingresosMes[m] || 0, registros: registrosMes[m] || 0 })),
    // Clientes de pago que vencen en los próximos 7 días (para avisarles a tiempo)
    porVencer: db.prepare(`
      SELECT id, email, plan, vence FROM usuarios
      WHERE activo = 1 AND plan != 'prueba' AND vence >= ? AND vence <= ? ORDER BY vence ASC LIMIT 8
    `).all(h, sumarDias(h, 7)).map(u => ({ ...u, diasRestantes: diasEntre(h, u.vence) })),
    // Pruebas que terminan en 2 días o menos (buen momento para ofrecerles un plan)
    pruebasPorTerminar: db.prepare(`
      SELECT id, email, vence FROM usuarios WHERE activo = 1 AND plan = 'prueba' AND vence >= ? AND vence <= ? ORDER BY vence ASC LIMIT 8
    `).all(h, sumarDias(h, 2)).map(u => ({ ...u, diasRestantes: diasEntre(h, u.vence) })),
  };
}

// ---------- Acciones sobre un usuario (las usa el panel) ----------
const bloquearUsuario = (id, bloqueado) => db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(bloqueado ? 0 : 1, id);
function sumarDiasUsuario(id, dias) {
  const u = usuarioPorId(id);
  const vence = sumarDias(u.vence > hoy() ? u.vence : hoy(), dias);
  db.prepare('UPDATE usuarios SET vence = ?, activo = 1 WHERE id = ?').run(vence, id);
  return vence;
}
const cambiarPlanUsuario = (id, plan) => db.prepare('UPDATE usuarios SET plan = ? WHERE id = ?').run(plan, id);
const cambiarClaveUsuario = (id, hash) => db.prepare('UPDATE usuarios SET hash = ? WHERE id = ?').run(hash, id);
// Devuelve false si ese correo ya pertenece a otra cuenta
function cambiarEmailUsuario(id, email) {
  const otro = usuarioPorEmail(email);
  if (otro && otro.id !== id) return false;
  db.prepare('UPDATE usuarios SET email = ? WHERE id = ?').run(email, id);
  return true;
}
const fijarVenceUsuario = (id, fecha) => db.prepare('UPDATE usuarios SET vence = ? WHERE id = ?').run(fecha, id);

// Anota un cobro hecho fuera de Stripe/PayPal (efectivo, transferencia...) para que cuente en tus ventas
function anotarPagoManual({ email, hash, plan, monto, metodo }) {
  db.prepare(`
    INSERT INTO pagos (id, email, hash, plan, proveedor, estado, monto, pagado_en)
    VALUES (?, ?, ?, ?, ?, 'pagado', ?, datetime('now'))
  `).run('m' + crypto.randomBytes(8).toString('hex'), email, hash, plan, metodo, monto);
}
// Cobro manual + renovación: anota el dinero y suma los días del plan
function registrarCobroManual(usuario, { plan, dias, monto, metodo }) {
  anotarPagoManual({ email: usuario.email, hash: usuario.hash, plan, monto, metodo });
  return activarAcceso({ email: usuario.email, hash: usuario.hash, plan, dias });
}
const reiniciarUsoUsuario = id => db.prepare('DELETE FROM uso WHERE usuario_id = ?').run(id);
function borrarUsuario(id) {
  // Los pagos y el registro de la prueba se conservan (son tu contabilidad y evitan pruebas repetidas)
  db.prepare('DELETE FROM uso WHERE usuario_id = ?').run(id);
  db.prepare('DELETE FROM redes WHERE usuario_id = ?').run(id);
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
}

module.exports = {
  db, hoy, mesActual, sumarDias, diasEntre, ultimosMeses,
  usuarioPorId, usuarioPorEmail, planDe, activarAcceso,
  usoDelMes, usoTotal, usoParaPlan, sumarUso,
  normalizarEmail, registrarPrueba,
  crearPago, obtenerPago, guardarReferencia, marcarPagado,
  guardarRed, obtenerRed, listarRedes, borrarRed,
  leerAjuste, guardarAjuste, aplicarAjustes, guardarPlan, guardarPrueba,
  estadoUsuario, listarUsuarios, listarPagos, resumen,
  bloquearUsuario, sumarDiasUsuario, cambiarPlanUsuario, cambiarClaveUsuario, reiniciarUsoUsuario, borrarUsuario,
  cambiarEmailUsuario, fijarVenceUsuario, anotarPagoManual, registrarCobroManual,
};