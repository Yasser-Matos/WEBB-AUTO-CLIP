// =====================================================================
// VIDEOCLIPS - Servidor (Node.js + Express)
// Todo el proyecto usa UN solo lenguaje: JavaScript.
//
// Archivos del proyecto:
//   config.js    -> precios, planes y límites (aquí cambias números)
//   db.js        -> base de datos (usuarios, pagos, redes)
//   cortador.js  -> decide dónde y cómo se corta cada clip
//   analisis.js  -> encuentra los "mejores momentos" del video
//   cola.js      -> fila de espera cuando hay muchos videos a la vez
//   pagos.js     -> cobro automático con Stripe y PayPal
//   redes.js     -> publicar directo en YouTube, TikTok e Instagram
//   zip.js       -> descargar todos los clips en un solo archivo
//   public/      -> la página que ve el usuario
//
// NADA se guarda: el video original se borra al terminar y los clips a los 20 min.
// =====================================================================

const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const C = require('./config');
const U = require('./utiles');
const DB = require('./db');
const K = require('./cortador');
const A = require('./analisis');
const { crearCola } = require('./cola');
const { escribirZip } = require('./zip');
const pagos = require('./pagos');
const redes = require('./redes');
const panel = require('./panel');

if (C.JWT_SECRET === 'cambia-esta-clave-larga') {
  console.warn('⚠️  Estás usando la clave JWT por defecto. Pon JWT_SECRET en las Variables de Railway.');
}

// ---------------------- CARPETA TEMPORAL ----------------------
const TMP = path.join(os.tmpdir(), 'videoclips');
fs.mkdirSync(path.join(TMP, 'subidas'), { recursive: true });
// Al iniciar borramos restos de ejecuciones anteriores (no guardamos nada)
for (const sub of fs.readdirSync(TMP)) {
  if (sub === 'subidas') for (const f of fs.readdirSync(path.join(TMP, 'subidas'))) fs.rmSync(path.join(TMP, 'subidas', f), { force: true });
  else U.borrarCarpeta(path.join(TMP, sub));
}

// Trabajos en memoria (se pierden si el servidor reinicia, y está bien: no guardamos nada)
const trabajos = new Map();
const cola = crearCola({ maxActivos: C.MAX_TRABAJOS_A_LA_VEZ, maxEspera: C.MAX_COLA });

// ---------------------- SERVIDOR ----------------------
const app = express();
app.set('trust proxy', 1);                   // necesario detrás de Railway (https)
pagos.montarWebhook(app, express);           // debe ir ANTES de express.json()
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, archivo) => { if (/(sw\.js|\.html)$/.test(archivo)) res.setHeader('Cache-Control', 'no-cache'); },
}));

// Recibe el video y el logo (si hay). Los archivos van a la carpeta temporal.
const subir = multer({
  dest: path.join(TMP, 'subidas'),
  limits: { fileSize: C.MAX_TAMANO_MB * 1024 * 1024, files: 2 },
}).fields([{ name: 'video', maxCount: 1 }, { name: 'logo', maxCount: 1 }]);

function recibirArchivos(req, res, next) {
  subir(req, res, err => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `El archivo supera ${C.MAX_TAMANO_MB} MB` : 'No se pudo recibir el archivo';
    res.status(400).json({ error: msg });
  });
}

// ---------------------- LOGIN ----------------------
// Middleware: revisa que el usuario esté conectado, activo y no vencido
function requiereLogin(req, res, next) {
  try {
    const { id } = jwt.verify(req.cookies.token, C.JWT_SECRET);
    const u = DB.usuarioPorId(id);
    if (!u || !u.activo) return res.status(401).json({ error: 'Cuenta desactivada' });
    if (u.vence < DB.hoy()) {
      return res.status(401).json({
        error: u.plan === 'prueba' ? 'Tu prueba gratis terminó. Elige un plan para seguir.' : 'Tu acceso venció. Renueva para continuar.',
        vencido: true,
      });
    }
    req.usuario = u;
    next();
  } catch {
    res.status(401).json({ error: 'Inicia sesión' });
  }
}

app.post('/api/login', U.limitador(10, 10 * 60 * 1000), (req, res) => {
  const { email, password } = req.body || {};
  const u = DB.usuarioPorEmail(String(email || '').toLowerCase().trim());
  if (!u || !bcrypt.compareSync(String(password || ''), u.hash)) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
  }
  darSesion(res, u.id);
  res.json({ ok: true });
});

// Guarda la sesión del usuario en una cookie (7 días)
function darSesion(res, id) {
  const token = jwt.sign({ id }, C.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 3600 * 1000,
  });
}

// Prueba gratis: crea la cuenta y deja la sesión iniciada
app.post('/api/registro', U.limitador(10, 60 * 60 * 1000), (req, res) => {
  const correo = String((req.body || {}).email || '').toLowerCase().trim();
  const clave = String((req.body || {}).password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo) || correo.length > 120) return res.status(400).json({ error: 'Escribe un correo válido' });
  if (clave.length < 6 || clave.length > 100) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  const r = DB.registrarPrueba({ email: correo, hash: bcrypt.hashSync(clave, 10), ip: req.ip });
  if (r.error) return res.status(400).json({ error: r.error });
  darSesion(res, r.usuario.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

// Datos de la cuenta: plan, límites y cuánto ha usado este mes
app.get('/api/yo', requiereLogin, (req, res) => {
  const u = req.usuario;
  const plan = DB.planDe(u);
  res.json({
    email: u.email,
    vence: u.vence,
    diasRestantes: DB.diasEntre(DB.hoy(), u.vence),
    plan: { id: C.PLANES[u.plan] ? u.plan : C.PLAN_POR_DEFECTO, ...plan },
    uso: DB.usoParaPlan(u.id, plan),         // videos usados (este mes; en la prueba, en total)
    limites: {
      maxClips: Math.min(C.MAX_CLIPS, plan.maxClips),
      maxDuracion: Math.min(C.MAX_DURACION_CLIP, plan.maxDuracion),
    },
  });
});

// (El panel de administración y la ruta para crear usuarios a mano están en panel.js)

// ---------------------- PROCESAR VIDEO ----------------------
app.post('/api/procesar', requiereLogin, recibirArchivos, (req, res) => {
  const video = req.files && req.files.video && req.files.video[0];
  const logoSubido = req.files && req.files.logo && req.files.logo[0];
  const error = (codigo, mensaje) => {
    for (const f of [video, logoSubido]) if (f) fs.rm(f.path, () => {});
    return res.status(codigo).json({ error: mensaje });
  };

  const plan = DB.planDe(req.usuario);
  const maxClips = Math.min(C.MAX_CLIPS, plan.maxClips);
  const maxDur = Math.min(C.MAX_DURACION_CLIP, plan.maxDuracion);
  const b = req.body;

  const modo = ['parejo', 'mejores', 'iguales'].includes(b.modo) ? b.modo : 'parejo';
  const formato = ['original', 'vertical', 'cuadrado'].includes(b.formato) ? b.formato : 'original';
  const cantidad = Math.floor(Number(b.cantidad));
  const duracion = Math.floor(Number(b.duracion));
  const link = String(b.link || '').trim();
  const desde = U.parseTiempo(b.desde);
  const hasta = U.parseTiempo(b.hasta);

  // ---- Validaciones ----
  if (!cantidad || cantidad < 1 || cantidad > maxClips) return error(400, `Cantidad de clips: 1 a ${maxClips} (según tu plan)`);
  if (modo !== 'iguales' && (!duracion || duracion < 3 || duracion > maxDur)) return error(400, `Duración por clip: 3 a ${maxDur} segundos (según tu plan)`);
  if (Number.isNaN(desde) || Number.isNaN(hasta)) return error(400, 'Escribe el tramo así: 1:30 (minutos:segundos) o en segundos');
  if (desde !== null && hasta !== null && desde >= hasta) return error(400, 'El "desde" debe ser menor que el "hasta"');
  if (!video && !U.linkPermitido(link)) return error(400, 'Sube un video o pega un link válido (http o https)');

  let rutaLogoSubido = null;
  if (logoSubido) {
    if (!plan.logo) return error(403, 'Poner tu logo es del plan Pro. Mejora tu plan para usarlo.');
    if (logoSubido.size > C.MAX_LOGO_KB * 1024) return error(400, `El logo pesa demasiado (máximo ${C.MAX_LOGO_KB} KB)`);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(logoSubido.mimetype)) return error(400, 'El logo debe ser PNG, JPG o WEBP');
    rutaLogoSubido = logoSubido;
  }

  if (DB.usoParaPlan(req.usuario.id, plan) >= plan.videosPorMes) {
    return error(403, plan.esPrueba
      ? `Ya usaste los ${plan.videosPorMes} videos de tu prueba gratis. Compra un plan para seguir creando clips.`
      : `Ya usaste tus ${plan.videosPorMes} videos de este mes. Mejora tu plan o espera al próximo mes.`);
  }
  if (cola.cantidadDe(req.usuario.id) >= C.MAX_TRABAJOS_POR_USUARIO) {
    return error(429, 'Ya tienes videos en proceso. Espera a que terminen.');
  }

  // ---- Crear el trabajo ----
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });

  let logo = null;
  if (rutaLogoSubido) {
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[rutaLogoSubido.mimetype];
    const ruta = path.join(dir, 'logo' + ext);
    fs.renameSync(rutaLogoSubido.path, ruta);
    logo = {
      ruta,
      posicion: K.POSICIONES_LOGO.includes(b.logoPosicion) ? b.logoPosicion : 'br',
      tamano: Object.keys(K.TAMANOS_LOGO).includes(b.logoTamano) ? b.logoTamano : 'medio',
    };
  }

  const trabajo = {
    id, userId: req.usuario.id, estado: 'en_cola', mensaje: 'En espera...', progreso: 0,
    clips: [], dir, formato, expira: null,
  };
  trabajos.set(id, trabajo);

  const opciones = {
    archivo: video ? video.path : null, link, cantidad, duracion, modo, formato, logo,
    desde: desde === null ? 0 : desde, hasta, maxDuracion: maxDur,
  };
  const aceptado = cola.agregar({ id, userId: req.usuario.id, correr: () => procesar(trabajo, opciones) });
  if (!aceptado) {
    trabajos.delete(id);
    U.borrarCarpeta(dir);
    return error(503, 'El servidor está muy ocupado. Intenta en unos minutos.');
  }
  DB.sumarUso(req.usuario.id, 1);
  res.json({ id });   // respondemos ya; el trabajo sigue en segundo plano
});

async function procesar(t, o) {
  t.estado = 'procesando';
  t.mensaje = 'Preparando...';
  let origen = o.archivo;
  try {
    // 1) Si viene un link, lo descargamos con yt-dlp
    if (!origen) {
      t.mensaje = 'Descargando el video del link...';
      await U.ejecutar('yt-dlp', [
        '--no-playlist', '--no-warnings', '--max-filesize', '1G', '--socket-timeout', '30',
        '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4',
        '-o', path.join(t.dir, 'origen.%(ext)s'), '--', o.link,
      ], { timeoutMs: 10 * 60 * 1000 });
      const f = fs.readdirSync(t.dir).find(n => n.startsWith('origen.') && !/\.(part|ytdl)$/.test(n));
      if (!f) throw new Error('No se pudo descargar el video de ese link');
      origen = path.join(t.dir, f);
    }

    // 2) Medimos el video y el tramo que se va a usar
    t.mensaje = 'Leyendo el video...';
    const info = await K.sondear(origen);
    const hasta = Math.min(o.hasta === null ? info.duracion : o.hasta, info.duracion);
    if (o.desde >= hasta) throw new Error('El tramo elegido está fuera del video (dura ' + Math.floor(info.duracion) + ' segundos)');

    // Si hay logo, comprobamos que de verdad sea una imagen
    if (o.logo) {
      try { await U.ejecutar('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', o.logo.ruta], { timeoutMs: 20000 }); }
      catch { throw new Error('El logo no es una imagen válida'); }
    }

    // 3) Mejores momentos (si lo pidió) y cálculo de dónde empieza cada clip
    let puntos = null;
    if (o.modo === 'mejores') {
      t.mensaje = 'Buscando los mejores momentos...';
      puntos = await A.puntuacionesPorSegundo(origen, o.desde, hasta);
    }
    const { inicios, dur, aviso } = K.calcularInicios({
      desde: o.desde, hasta, modo: o.modo, cantidad: o.cantidad, duracion: o.duracion, puntos,
    });
    if (dur > o.maxDuracion) {
      throw new Error(`Cada parte duraría ${dur} s y tu plan permite hasta ${o.maxDuracion} s. Sube la cantidad de partes.`);
    }

    // 4) Cortamos cada clip con ffmpeg
    const dims = K.dimensionesSalida(o.formato, info.ancho, info.alto);
    for (let i = 0; i < inicios.length; i++) {
      t.mensaje = `Cortando clip ${i + 1} de ${inicios.length}...`;
      const salida = path.join(t.dir, `clip_${i + 1}.mp4`);
      await U.ejecutar('ffmpeg', K.construirArgs({
        origen, inicio: inicios[i], dur, salida, formato: o.formato, dims, logo: o.logo,
      }), { timeoutMs: 10 * 60 * 1000 });
      t.clips.push({ n: i + 1, inicio: Math.round(inicios[i]), duracion: dur });
      t.progreso = Math.round(((i + 1) / inicios.length) * 100);
    }
    t.estado = 'listo';
    t.mensaje = `Listo: ${inicios.length} clips.` + (aviso ? ' ' + aviso : '');
  } catch (e) {
    t.estado = 'error';
    t.mensaje = 'No se pudo procesar: ' + String(e.message).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200);
    DB.sumarUso(t.userId, -1);            // si falló, no le descontamos el video de su mes
    U.borrarCarpeta(t.dir);
  } finally {
    // Borramos el video original YA (no se guarda)
    if (o.archivo) fs.rm(o.archivo, () => {});
    else if (origen) fs.rm(origen, () => {});
    // Los clips se borran solos pasado el tiempo de vida
    t.expira = Date.now() + C.MINUTOS_VIDA_CLIPS * 60 * 1000;
    setTimeout(() => { U.borrarCarpeta(t.dir); trabajos.delete(t.id); }, C.MINUTOS_VIDA_CLIPS * 60 * 1000);
  }
}

// Estado del trabajo (la página lo consulta cada 2 segundos)
app.get('/api/trabajo/:id', requiereLogin, (req, res) => {
  const t = trabajos.get(req.params.id);
  if (!t || t.userId !== req.usuario.id) return res.status(404).json({ error: 'Trabajo no encontrado o ya expiró' });
  res.json({
    estado: t.estado, mensaje: t.mensaje, progreso: t.progreso, clips: t.clips, formato: t.formato,
    posicion: cola.posicion(t.id),
    expiraEn: t.expira ? Math.max(0, Math.round((t.expira - Date.now()) / 1000)) : null,
  });
});

// Busca un clip que pertenezca a este usuario
function clipDe(userId, id, n) {
  const t = trabajos.get(id);
  if (!t || t.userId !== userId || !t.clips.find(c => c.n === n)) return null;
  const archivo = path.join(t.dir, `clip_${n}.mp4`);
  if (!fs.existsSync(archivo)) return null;
  return { archivo, n, trabajoId: id, vertical: t.formato === 'vertical' };
}

// Descargar / reproducir un clip
app.get('/api/clip/:id/:n', requiereLogin, (req, res) => {
  const clip = clipDe(req.usuario.id, req.params.id, parseInt(req.params.n, 10));
  if (!clip) return res.status(404).end();
  if (req.query.descargar) res.setHeader('Content-Disposition', `attachment; filename="clip_${clip.n}.mp4"`);
  res.sendFile(clip.archivo);   // soporta reproducción con "adelantar" en el navegador
});

// Descargar TODOS los clips en un .zip
app.get('/api/zip/:id', requiereLogin, (req, res) => {
  const t = trabajos.get(req.params.id);
  if (!t || t.userId !== req.usuario.id || t.estado !== 'listo') return res.status(404).end();
  const archivos = t.clips.map(c => ({ nombre: `clip_${c.n}.mp4`, ruta: path.join(t.dir, `clip_${c.n}.mp4`) }))
    .filter(a => fs.existsSync(a.ruta));
  if (!archivos.length) return res.status(404).end();
  escribirZip(res, archivos, 'clips.zip').catch(() => res.destroy());
});

// Enlace temporal y firmado (lo necesita Instagram para bajar el video). Dura 1 hora.
app.get('/api/publico/:id/:n', (req, res) => {
  const n = parseInt(req.params.n, 10);
  const exp = String(req.query.exp || '');
  const valido = exp && Number(exp) > Date.now() / 1000 &&
    U.igualesSeguros(String(req.query.f || ''), U.firmar(`${req.params.id}.${n}.${exp}`));
  const t = trabajos.get(req.params.id);
  if (!valido || !t || !t.clips.find(c => c.n === n)) return res.status(403).end();
  const archivo = path.join(t.dir, `clip_${n}.mp4`);
  if (!fs.existsSync(archivo)) return res.status(404).end();
  res.sendFile(archivo);
});

// ---------------------- PAGOS Y REDES ----------------------
pagos.montar(app, { bcrypt });
redes.montar(app, { jwt, requiereLogin, clipDe });
panel.montar(app, {
  jwt, bcrypt,
  estadoServidor: () => ({ activos: cola.activos, esperando: cola.esperando, trabajos: trabajos.size }),
});

// Cualquier error inesperado responde en JSON (la página lo entiende)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error del servidor' });
});

app.listen(C.PUERTO, () => console.log(`VideoClips corriendo en http://localhost:${C.PUERTO}`));
