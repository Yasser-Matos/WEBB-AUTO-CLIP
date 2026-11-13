// =====================================================================
// UTILIDADES - funciones pequeñas que usan varios archivos
// =====================================================================
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const C = require('./config');

// Ejecuta un programa (ffmpeg, yt-dlp...) y devuelve lo que imprime.
// Sin "shell" => más seguro. Si pasas timeoutMs y tarda más, lo corta.
function ejecutar(cmd, args, opciones = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', vencido = false;
    const reloj = opciones.timeoutMs
      ? setTimeout(() => { vencido = true; p.kill('SIGKILL'); }, opciones.timeoutMs)
      : null;
    p.stdout.on('data', d => { if (out.length < 20e6) out += d; });
    p.stderr.on('data', d => { err += d; if (err.length > 5000) err = err.slice(-5000); });
    p.on('error', e => { if (reloj) clearTimeout(reloj); reject(new Error(`No se pudo ejecutar ${cmd}: ${e.message}`)); });
    p.on('close', code => {
      if (reloj) clearTimeout(reloj);
      if (vencido) return reject(new Error(`${cmd} tardó demasiado y se canceló`));
      code === 0 ? resolve(out) : reject(new Error(err || `${cmd} terminó con código ${code}`));
    });
  });
}

// Borra una carpeta entera sin dar error si no existe
function borrarCarpeta(dir) {
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

// Convierte "90", "1:30" o "1:02:03" a segundos. Vacío => null. Inválido => NaN.
function parseTiempo(texto) {
  const t = String(texto ?? '').trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/);
  if (!m) return NaN;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// Comparar claves sin filtrar información por tiempo de respuesta
function igualesSeguros(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Dirección pública de tu web (para los enlaces de pago y conexión a redes)
function baseUrl(req) {
  if (process.env.URL_PUBLICA) return process.env.URL_PUBLICA.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// Cifrado para guardar los permisos de redes sociales (tokens) en la base de datos
const CLAVE = crypto.createHash('sha256').update('redes:' + C.JWT_SECRET).digest();
function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', CLAVE, iv);
  const datos = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), datos]).toString('base64');
}
function descifrar(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', CLAVE, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// Freno anti-abuso: permite "max" peticiones por IP cada "ventanaMs" milisegundos.
function limitador(max, ventanaMs) {
  const golpes = new Map();
  setInterval(() => {
    const ahora = Date.now();
    for (const [k, v] of golpes) if (v.hasta < ahora) golpes.delete(k);
  }, ventanaMs).unref();
  return (req, res, next) => {
    const ahora = Date.now();
    let g = golpes.get(req.ip);
    if (!g || g.hasta < ahora) { g = { n: 0, hasta: ahora + ventanaMs }; golpes.set(req.ip, g); }
    if (++g.n > max) return res.status(429).json({ error: 'Demasiados intentos. Espera un momento y vuelve a probar.' });
    next();
  };
}

// Seguridad: el servidor descarga el link que pega el usuario, así que bloqueamos
// direcciones internas (localhost, redes privadas) para que nadie use tu servidor para espiar tu red.
function linkPermitido(texto) {
  let u;
  try { u = new URL(texto); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return false;
  if (h.includes(':')) return false;                        // direcciones IPv6 directas
  if (/^[\d.]+$/.test(h)) {                                 // dirección IPv4 directa
    const p = h.split('.').map(Number);
    if (p.length !== 4 || p.some(x => x > 255)) return false;
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return false;
    if (p[0] === 169 && p[1] === 254) return false;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;
  }
  return true;
}

// Firma para enlaces temporales (Instagram necesita un link público al clip)
function firmar(texto) {
  return crypto.createHmac('sha256', C.JWT_SECRET).update(texto).digest('hex').slice(0, 32);
}

module.exports = { ejecutar, borrarCarpeta, parseTiempo, igualesSeguros, baseUrl, cifrar, descifrar, limitador, linkPermitido, firmar };
