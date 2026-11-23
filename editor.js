// =====================================================================
// EDITOR DE CLIPS
// Aquí está lo que pasa cuando el cliente toca "Editar" en un clip:
// recortar el inicio/fin, cambiar la velocidad, el volumen y poner
// texto o subtítulos sobre el video.
//
// Siempre se parte del clip ORIGINAL (clip_N.orig.mp4), así el cliente
// puede cambiar de idea las veces que quiera sin que el video pierda calidad.
// =====================================================================
const fs = require('fs');
const path = require('path');
const { ejecutar } = require('./utiles');
const K = require('./cortador');

// ---------- Tipografía ----------
// ffmpeg necesita un archivo de letra para dibujar texto. Se busca en los sitios
// típicos de Linux. Si tu servidor usa otra, ponla en la variable FUENTE_TEXTO.
const FUENTES = [
  process.env.FUENTE_TEXTO,
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
].filter(Boolean);

function buscarFuente() {
  const f = FUENTES.find(r => { try { return fs.existsSync(r); } catch { return false; } });
  if (!f) throw new Error('El servidor no tiene una tipografía instalada para escribir texto. Avisa al administrador.');
  return f;
}

// ---------- Opciones que puede elegir el cliente ----------
const COLORES = { blanco: 'white', amarillo: 'yellow', rojo: 'red', verde: 'lime', celeste: 'cyan', naranja: 'orange', negro: 'black' };
const TAMANOS = { chico: 0.03, medio: 0.045, grande: 0.065 };   // proporción del alto del video
const POSICIONES = ['arriba', 'centro', 'abajo'];
const VELOCIDADES = [0.5, 0.75, 1, 1.25, 1.5, 2];

const MAX_LINEAS = 20;       // textos + subtítulos por clip
const MAX_LARGO_TEXTO = 200; // caracteres por texto

const num = (v, def) => { const n = parseFloat(v); return Number.isFinite(n) ? n : def; };
const entre = (v, a, b) => Math.min(b, Math.max(a, v));
const redondear = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// Limpia lo que manda la página (nunca nos fiamos de lo que llega) y lo deja en un formato seguro.
// "duracion" es lo que dura el clip original, en segundos.
function limpiarPedido(body, duracion) {
  const b = body && typeof body === 'object' ? body : {};

  // Recorte (en segundos del clip original). Mínimo 1 segundo.
  let desde = entre(num(b.recorte && b.recorte.desde, 0), 0, duracion);
  let hasta = entre(num(b.recorte && b.recorte.hasta, duracion), 0, duracion);
  if (hasta - desde < 1) {
    if (desde + 1 <= duracion) hasta = desde + 1; else { hasta = duracion; desde = Math.max(0, duracion - 1); }
  }

  // Velocidad: solo las de la lista
  const vel = num(b.velocidad, 1);
  const velocidad = VELOCIDADES.reduce((a, x) => Math.abs(x - vel) < Math.abs(a - vel) ? x : a, 1);

  // Volumen: 0 (mudo) a 200 %
  const volumen = Math.round(entre(num(b.volumen, 100), 0, 200));

  // Cuánto durará el clip ya editado
  const durFinal = (hasta - desde) / velocidad;

  const limpiaTiempo = (t, def) => {
    const v = num(t, null);
    return v === null ? def : redondear(entre(v, 0, durFinal));
  };

  const lineas = [];
  const agregar = (x, esSubtitulo) => {
    if (!x || typeof x !== 'object' || lineas.length >= MAX_LINEAS) return;
    const texto = String(x.texto == null ? '' : x.texto).replace(/\r/g, '').slice(0, MAX_LARGO_TEXTO).trim();
    if (!texto) return;
    let d = limpiaTiempo(x.desde, 0), h = limpiaTiempo(x.hasta, durFinal);
    if (h <= d) h = Math.min(durFinal, d + 2);
    lineas.push(esSubtitulo
      ? { texto, pos: 'abajo', tam: 'medio', color: 'blanco', fondo: true, desde: d, hasta: h, subtitulo: true }
      : {
        texto,
        pos: POSICIONES.includes(x.pos) ? x.pos : 'abajo',
        tam: TAMANOS[x.tam] ? x.tam : 'medio',
        color: COLORES[x.color] ? x.color : 'blanco',
        fondo: !!x.fondo,
        desde: d, hasta: h,
      });
  };
  (Array.isArray(b.textos) ? b.textos : []).forEach(x => agregar(x, false));
  (Array.isArray(b.subtitulos) ? b.subtitulos : []).forEach(x => agregar(x, true));

  return { recorte: { desde: redondear(desde), hasta: redondear(hasta) }, velocidad, volumen, lineas, durFinal: redondear(durFinal) };
}

// ---------- Texto en varias líneas ----------
// drawtext no parte las líneas solo: lo hacemos aquí según el ancho del video.
function partirTexto(texto, maxCaracteres) {
  const salida = [];
  for (const parrafo of texto.split('\n')) {
    let linea = '';
    for (let palabra of parrafo.split(/\s+/).filter(Boolean)) {
      while (palabra.length > maxCaracteres) {          // palabra enorme: se corta
        if (linea) { salida.push(linea); linea = ''; }
        salida.push(palabra.slice(0, maxCaracteres));
        palabra = palabra.slice(maxCaracteres);
      }
      if (!linea) linea = palabra;
      else if ((linea + ' ' + palabra).length <= maxCaracteres) linea += ' ' + palabra;
      else { salida.push(linea); linea = palabra; }
    }
    salida.push(linea);
  }
  return salida.join('\n');
}

// ---------- Construcción del comando de ffmpeg ----------
// Devuelve { args, archivosTemporales }. Los textos se escriben en archivos .txt
// para no tener problemas con comillas, dos puntos, etc.
function construirArgs({ entrada, salida, info, tieneAudio, pedido, dir, n }) {
  const fuente = pedido.lineas.length ? buscarFuente() : null;
  const temporales = [];
  const filtrosV = [];

  if (pedido.velocidad !== 1) filtrosV.push(`setpts=PTS/${pedido.velocidad}`);

  pedido.lineas.forEach((l, i) => {
    let px = Math.max(12, Math.round(info.alto * TAMANOS[l.tam] / 2) * 2);
    const maxCar = () => Math.max(6, Math.floor((info.ancho * 0.88) / (px * 0.66)));
    let textoFinal = partirTexto(l.texto, maxCar());
    // Si el texto no cabe (muy largo), se achica la letra hasta que ocupe como máximo el 40 % del alto
    while (px > 16 && textoFinal.split('\n').length * px * 1.25 > info.alto * 0.4) {
      px = Math.max(16, Math.round(px * 0.9 / 2) * 2);
      textoFinal = partirTexto(l.texto, maxCar());
    }
    const archivoTxt = path.join(dir, `clip_${n}.txt${i}`);
    fs.writeFileSync(archivoTxt, textoFinal, 'utf8');
    temporales.push(archivoTxt);

    const y = l.pos === 'arriba' ? 'h*0.07'
      : l.pos === 'centro' ? '(h-text_h)/2'
        : (l.subtitulo ? 'h-text_h-h*0.10' : 'h-text_h-h*0.09');
    const opciones = [
      `fontfile='${fuente}'`,
      `textfile='${archivoTxt}'`,
      'expansion=none',
      `fontsize=${px}`,
      `fontcolor=${COLORES[l.color]}`,
      'x=(w-text_w)/2',
      `y=${y}`,
      `line_spacing=${Math.round(px * 0.2)}`,
      l.fondo
        ? `box=1:boxcolor=black@0.6:boxborderw=${Math.round(px * 0.3)}`
        : `borderw=${Math.max(2, Math.round(px / 14))}:bordercolor=${l.color === 'negro' ? 'white' : 'black'}`,
      `enable='between(t,${l.desde},${l.hasta})'`,
    ];
    filtrosV.push('drawtext=' + opciones.join(':'));
  });

  const args = ['-nostdin', '-y', '-v', 'error',
    // OJO: -ss y -t van ANTES de -i para que corten el video original (y no el ya acelerado)
    '-ss', String(pedido.recorte.desde), '-t', String(redondear(pedido.recorte.hasta - pedido.recorte.desde)),
    '-i', entrada];

  if (filtrosV.length) args.push('-vf', filtrosV.join(','));
  args.push('-map', '0:v:0');

  if (!tieneAudio || pedido.volumen === 0) {
    args.push('-an');
  } else {
    const filtrosA = [];
    if (pedido.velocidad !== 1) filtrosA.push(`atempo=${pedido.velocidad}`);
    if (pedido.volumen !== 100) filtrosA.push(`volume=${pedido.volumen / 100}`);
    args.push('-map', '0:a:0');
    if (filtrosA.length) args.push('-af', filtrosA.join(','));
    args.push('-c:a', 'aac', '-b:a', '128k');
  }

  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    // Poca memoria (igual que el cortador): el servidor es pequeño
    '-threads', '2', '-x264-params', 'rc-lookahead=10:sync-lookahead=0:ref=2',
    '-movflags', '+faststart', salida);
  return { args, temporales };
}

// ¿El clip tiene sonido?
async function tieneAudio(archivo) {
  const out = await ejecutar('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', archivo], { timeoutMs: 30000 });
  return out.trim().length > 0;
}

// Hace la edición completa. Devuelve la duración final en segundos.
async function renderizar({ original, salida, pedido, dir, n }) {
  const info = await K.sondear(original);
  const audio = await tieneAudio(original);
  const { args, temporales } = construirArgs({ entrada: original, salida, info, tieneAudio: audio, pedido, dir, n });
  try {
    await ejecutar('ffmpeg', args, { timeoutMs: 5 * 60 * 1000 });
  } finally {
    for (const t of temporales) fs.rm(t, () => {});
  }
  const fin = await K.sondear(salida);
  return fin.duracion;
}

module.exports = { limpiarPedido, construirArgs, renderizar, partirTexto, buscarFuente, COLORES, TAMANOS, POSICIONES, VELOCIDADES };
