// =====================================================================
// PUBLICAR DIRECTO EN REDES (YouTube, TikTok, Instagram)
//
// El usuario conecta su cuenta una vez (botón "Conectar") y después publica
// cada clip con un clic. Los permisos se guardan CIFRADOS en la base de datos.
//
// Variables en Railway (solo las redes que quieras activar):
//   YouTube  : GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//   TikTok   : TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_MODO ("borrador" o "directo")
//   Instagram: META_APP_ID, META_APP_SECRET, (opcional) META_VERSION
//
// IMPORTANTE: las tres plataformas exigen que registres una "app" de desarrollador y
// que la revisen antes de publicar para el público. Mira LEEME.md.
// =====================================================================
const fs = require('fs');
const C = require('./config');
const DB = require('./db');
const { cifrar, descifrar, baseUrl, firmar, limitador } = require('./utiles');

const env = process.env;
const META = () => `https://graph.facebook.com/${env.META_VERSION || 'v23.0'}`;

// ---------- Ayudas ----------
async function leerJson(r) {
  let j = {};
  try { j = await r.json(); } catch { /* sin cuerpo */ }
  if (!r.ok) {
    const m = j.error_description || (j.error && (j.error.message || j.error.code || j.error)) || `error ${r.status}`;
    throw new Error(typeof m === 'string' ? m : JSON.stringify(m));
  }
  return j;
}
const postForm = async (url, datos) =>
  leerJson(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(datos) }));
const dormir = ms => new Promise(r => setTimeout(r, ms));

// ---------- Cada red: cómo conectar y cómo publicar ----------
const REDES = {
  // ============ YOUTUBE (Shorts y videos) ============
  youtube: {
    etiqueta: 'YouTube',
    configurada: () => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    urlAuth(redirect, state) {
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code',
        scope: 'https://www.googleapis.com/auth/youtube.upload', access_type: 'offline', prompt: 'consent', state,
      });
    },
    async conectar(code, redirect) {
      const j = await postForm('https://oauth2.googleapis.com/token', {
        code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirect, grant_type: 'authorization_code',
      });
      if (!j.refresh_token) throw new Error('Google no entregó el permiso permanente. Intenta conectar otra vez.');
      return { datos: { refresh: j.refresh_token }, nombre: 'Canal conectado' };
    },
    async publicar(datos, { archivo, titulo, descripcion, privacidad, vertical }) {
      const tok = await postForm('https://oauth2.googleapis.com/token', {
        client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: datos.refresh, grant_type: 'refresh_token',
      });
      const tam = fs.statSync(archivo).size;
      const desc = vertical && !/#shorts/i.test(descripcion) ? `${descripcion}\n#Shorts`.trim() : descripcion;
      const ini = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(tam), 'X-Upload-Content-Type': 'video/mp4',
        },
        body: JSON.stringify({
          snippet: { title: titulo.slice(0, 100), description: desc.slice(0, 4900), categoryId: '22' },
          status: { privacyStatus: ['public', 'unlisted', 'private'].includes(privacidad) ? privacidad : 'private', selfDeclaredMadeForKids: false },
        }),
      });
      if (!ini.ok) await leerJson(ini);
      const destino = ini.headers.get('location');
      if (!destino) throw new Error('YouTube no dio dirección de subida');
      const j = await leerJson(await fetch(destino, {
        method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(tam) }, body: await fs.promises.readFile(archivo),
      }));
      return { url: `https://www.youtube.com/watch?v=${j.id}`, mensaje: 'Subido a YouTube' };
    },
  },

  // ============ TIKTOK (borrador en tu app, o publicación directa) ============
  tiktok: {
    etiqueta: 'TikTok',
    configurada: () => !!(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET),
    directo: () => env.TIKTOK_MODO === 'directo',
    urlAuth(redirect, state) {
      const scope = REDES.tiktok.directo() ? 'user.info.basic,video.publish' : 'user.info.basic,video.upload';
      return 'https://www.tiktok.com/v2/auth/authorize/?' + new URLSearchParams({
        client_key: env.TIKTOK_CLIENT_KEY, scope, response_type: 'code', redirect_uri: redirect, state,
      });
    },
    async conectar(code, redirect) {
      const j = await postForm('https://open.tiktokapis.com/v2/oauth/token/', {
        client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET,
        code, grant_type: 'authorization_code', redirect_uri: redirect,
      });
      if (!j.refresh_token) throw new Error('TikTok no entregó el permiso');
      return { datos: { refresh: j.refresh_token }, nombre: 'Cuenta conectada' };
    },
    async publicar(datos, { archivo, titulo, guardarDatos }) {
      const tok = await postForm('https://open.tiktokapis.com/v2/oauth/token/', {
        client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token', refresh_token: datos.refresh,
      });
      if (tok.refresh_token && tok.refresh_token !== datos.refresh) guardarDatos({ refresh: tok.refresh_token });   // TikTok rota el permiso
      const tam = fs.statSync(archivo).size;
      if (tam > 64 * 1024 * 1024) throw new Error('El clip pesa más de 64 MB; baja la duración para publicarlo en TikTok.');
      const directo = REDES.tiktok.directo();
      const cuerpo = { source_info: { source: 'FILE_UPLOAD', video_size: tam, chunk_size: tam, total_chunk_count: 1 } };
      if (directo) cuerpo.post_info = { title: titulo.slice(0, 150), privacy_level: 'SELF_ONLY', disable_comment: false };
      const ini = await leerJson(await fetch(
        `https://open.tiktokapis.com/v2/post/publish/${directo ? '' : 'inbox/'}video/init/`,
        { method: 'POST', headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(cuerpo) }));
      const subida = ini.data && ini.data.upload_url;
      if (!subida) throw new Error((ini.error && ini.error.message) || 'TikTok no dio dirección de subida');
      const r = await fetch(subida, {
        method: 'PUT',
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(tam), 'Content-Range': `bytes 0-${tam - 1}/${tam}` },
        body: await fs.promises.readFile(archivo),
      });
      if (!r.ok) throw new Error('TikTok rechazó la subida');
      return { url: null, mensaje: directo ? 'Enviado a TikTok (queda privado hasta que TikTok apruebe tu app)' : 'Listo: abre TikTok y revisa tus borradores para publicarlo' };
    },
  },

  // ============ INSTAGRAM (Reels) - necesita cuenta profesional ligada a una página de Facebook ============
  instagram: {
    etiqueta: 'Instagram',
    configurada: () => !!(env.META_APP_ID && env.META_APP_SECRET),
    urlAuth(redirect, state) {
      return `https://www.facebook.com/${env.META_VERSION || 'v23.0'}/dialog/oauth?` + new URLSearchParams({
        client_id: env.META_APP_ID, redirect_uri: redirect, state,
        scope: 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement',
      });
    },
    async conectar(code, redirect) {
      const corto = await leerJson(await fetch(`${META()}/oauth/access_token?` + new URLSearchParams({
        client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, redirect_uri: redirect, code })));
      const largo = await leerJson(await fetch(`${META()}/oauth/access_token?` + new URLSearchParams({
        grant_type: 'fb_exchange_token', client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, fb_exchange_token: corto.access_token })));
      const paginas = await leerJson(await fetch(`${META()}/me/accounts?` + new URLSearchParams({
        fields: 'instagram_business_account{id,username}', access_token: largo.access_token })));
      const pag = (paginas.data || []).find(p => p.instagram_business_account);
      if (!pag) throw new Error('No encontré una cuenta profesional de Instagram ligada a una página de Facebook.');
      return { datos: { token: largo.access_token, ig: pag.instagram_business_account.id }, nombre: '@' + (pag.instagram_business_account.username || 'instagram') };
    },
    async publicar(datos, { descripcion, titulo, urlPublica }) {
      const caption = [titulo, descripcion].filter(Boolean).join('\n\n').slice(0, 2200);
      // Instagram descarga el video desde un link público y temporal de este servidor
      const cont = await leerJson(await fetch(`${META()}/${datos.ig}/media`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ media_type: 'REELS', video_url: urlPublica, caption, access_token: datos.token }),
      }));
      for (let i = 0; i < 40; i++) {                       // espera hasta ~3 minutos a que Instagram lo procese
        await dormir(5000);
        const st = await leerJson(await fetch(`${META()}/${cont.id}?fields=status_code&access_token=${encodeURIComponent(datos.token)}`));
        if (st.status_code === 'FINISHED') break;
        if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error('Instagram no pudo procesar el video');
        if (i === 39) throw new Error('Instagram tardó demasiado en procesar el video');
      }
      const pub = await leerJson(await fetch(`${META()}/${datos.ig}/media_publish`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ creation_id: cont.id, access_token: datos.token }),
      }));
      let url = null;
      try { url = (await leerJson(await fetch(`${META()}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(datos.token)}`))).permalink; } catch { /* no es grave */ }
      return { url, mensaje: 'Publicado en Instagram' };
    },
  },
};

const redesConfiguradas = () => Object.keys(REDES).filter(r => REDES[r].configurada());

// ---------- RUTAS ----------
// requiereLogin y clipDe vienen de server.js
function montar(app, { jwt, requiereLogin, clipDe }) {
  const exigirPlan = (req, res, next) =>
    DB.planDe(req.usuario).publicar ? next()
      : res.status(403).json({ error: 'Publicar directo en redes es del plan Pro. Mejora tu plan para usarlo.' });

  // Estado de las conexiones
  app.get('/api/redes', requiereLogin, (req, res) => {
    const conectadas = DB.listarRedes(req.usuario.id);
    res.json(redesConfiguradas().map(r => ({
      red: r, etiqueta: REDES[r].etiqueta,
      conectada: conectadas.some(c => c.red === r), nombre: (conectadas.find(c => c.red === r) || {}).nombre || '',
      modo: r === 'tiktok' ? (REDES.tiktok.directo() ? 'directo' : 'borrador') : undefined,
    })));
  });

  // Empieza la conexión: manda al usuario a la página de la red social
  app.get('/api/redes/:red/conectar', requiereLogin, exigirPlan, (req, res) => {
    const red = REDES[req.params.red];
    if (!red || !red.configurada()) return res.redirect('/?red=error');
    const state = jwt.sign({ uid: req.usuario.id, red: req.params.red }, C.JWT_SECRET, { expiresIn: '10m' });
    res.redirect(red.urlAuth(`${baseUrl(req)}/api/redes/${req.params.red}/callback`, state));
  });

  // La red social vuelve aquí con un código
  app.get('/api/redes/:red/callback', async (req, res) => {
    try {
      const red = REDES[req.params.red];
      const estado = jwt.verify(String(req.query.state || ''), C.JWT_SECRET);
      if (!red || estado.red !== req.params.red || !req.query.code) return res.redirect('/?red=error');
      const r = await red.conectar(String(req.query.code), `${baseUrl(req)}/api/redes/${req.params.red}/callback`);
      DB.guardarRed(estado.uid, req.params.red, cifrar(JSON.stringify(r.datos)), r.nombre);
      res.redirect('/?red=ok');
    } catch (e) {
      console.error('[redes]', e.message);
      res.redirect('/?red=error');
    }
  });

  app.delete('/api/redes/:red', requiereLogin, (req, res) => {
    DB.borrarRed(req.usuario.id, req.params.red);
    res.json({ ok: true });
  });

  // Publicar un clip
  app.post('/api/publicar', requiereLogin, exigirPlan, limitador(30, 10 * 60 * 1000), async (req, res) => {
    try {
      const { trabajo, n, red, titulo, descripcion, privacidad } = req.body || {};
      const r = REDES[red];
      if (!r || !r.configurada()) return res.status(400).json({ error: 'Esa red no está disponible' });
      const guardada = DB.obtenerRed(req.usuario.id, red);
      if (!guardada) return res.status(400).json({ error: `Primero conecta tu cuenta de ${r.etiqueta}` });
      const clip = clipDe(req.usuario.id, String(trabajo), parseInt(n, 10));
      if (!clip) return res.status(404).json({ error: 'El clip ya expiró' });

      const datos = JSON.parse(descifrar(guardada.datos));
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const urlPublica = `${baseUrl(req)}/api/publico/${clip.trabajoId}/${clip.n}?exp=${exp}&f=${firmar(`${clip.trabajoId}.${clip.n}.${exp}`)}`;
      const resultado = await r.publicar(datos, {
        archivo: clip.archivo, vertical: clip.vertical, urlPublica,
        titulo: String(titulo || 'Mi clip').slice(0, 150), descripcion: String(descripcion || '').slice(0, 2000),
        privacidad: String(privacidad || 'private'),
        guardarDatos: nuevos => DB.guardarRed(req.usuario.id, red, cifrar(JSON.stringify(nuevos)), guardada.nombre),
      });
      res.json({ ok: true, ...resultado });
    } catch (e) {
      console.error('[redes]', e.message);
      res.status(502).json({ error: 'No se pudo publicar: ' + String(e.message).slice(0, 200) });
    }
  });
}

module.exports = { montar, redesConfiguradas };
