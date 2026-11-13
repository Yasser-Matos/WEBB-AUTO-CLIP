// =====================================================================
// BASE DE DATOS (SQLite) - usuarios, uso mensual, pagos y redes conectadas
// OJO: aquí NUNCA se guardan videos, solo datos de las cuentas.
// =====================================================================
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
`);

// Si la base viene de la versión anterior (sin planes), le agregamos la columna "plan"
const columnas = db.prepare('PRAGMA table_info(usuarios)').all().map(c => c.name);
if (!columnas.includes('plan')) {
  db.exec(`ALTER TABLE usuarios ADD COLUMN plan TEXT NOT NULL DEFAULT '${C.PLAN_POR_DEFECTO}'`);
}

// ---------- Fechas ----------
const hoy = () => new Date().toISOString().slice(0, 10);
const mesActual = () => new Date().toISOString().slice(0, 7);
function sumarDias(fecha, dias) {
  return new Date(Date.parse(fecha + 'T00:00:00Z') + dias * 86400000).toISOString().slice(0, 10);
}

// ---------- Usuarios y planes ----------
const usuarioPorId = id => db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
const usuarioPorEmail = email => db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);

// Devuelve la configuración del plan del usuario (si el plan ya no existe, usa el básico)
function planDe(usuario) {
  return C.PLANES[usuario.plan] || C.PLANES[C.PLAN_POR_DEFECTO];
}

// Crea el usuario o le renueva el acceso. Si todavía le quedan días, los nuevos se SUMAN.
function activarAcceso({ email, hash, plan, dias = C.DIAS_POR_COMPRA }) {
  const u = usuarioPorEmail(email);
  const base = u && u.vence > hoy() ? u.vence : hoy();
  const vence = sumarDias(base, dias);
  if (u) {
    db.prepare('UPDATE usuarios SET plan = ?, vence = ?, activo = 1 WHERE id = ?').run(plan, vence, u.id);
  } else {
    db.prepare('INSERT INTO usuarios (email, hash, vence, plan) VALUES (?, ?, ?, ?)').run(email, hash, vence, plan);
  }
  return { email, vence, plan };
}

// ---------- Uso mensual ----------
function usoDelMes(usuarioId) {
  const f = db.prepare('SELECT videos FROM uso WHERE usuario_id = ? AND mes = ?').get(usuarioId, mesActual());
  return f ? f.videos : 0;
}
function sumarUso(usuarioId, n) {
  db.prepare(`
    INSERT INTO uso (usuario_id, mes, videos) VALUES (?, ?, MAX(0, ?))
    ON CONFLICT(usuario_id, mes) DO UPDATE SET videos = MAX(0, videos + ?)
  `).run(usuarioId, mesActual(), n, n);
}

// ---------- Pagos ----------
function crearPago(p) {
  db.prepare('INSERT INTO pagos (id, email, hash, plan, proveedor) VALUES (?, ?, ?, ?, ?)')
    .run(p.id, p.email, p.hash, p.plan, p.proveedor);
}
const obtenerPago = id => db.prepare('SELECT * FROM pagos WHERE id = ?').get(id);
function guardarReferencia(id, ref) { db.prepare('UPDATE pagos SET referencia = ? WHERE id = ?').run(ref, id); }
// Pasa de "pendiente" a "pagado" UNA sola vez (evita activar dos veces si llegan dos avisos)
function marcarPagado(id) {
  return db.prepare(`UPDATE pagos SET estado = 'pagado' WHERE id = ? AND estado = 'pendiente'`).run(id).changes === 1;
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

module.exports = {
  db, hoy, mesActual, sumarDias,
  usuarioPorId, usuarioPorEmail, planDe, activarAcceso,
  usoDelMes, sumarUso,
  crearPago, obtenerPago, guardarReferencia, marcarPagado,
  guardarRed, obtenerRed, listarRedes, borrarRed,
};
