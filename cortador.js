// =====================================================================
// CORTADOR - la parte que decide DÓNDE cortar y CÓMO se ve cada clip.
// Aquí no hay nada de internet ni de usuarios: solo matemáticas y ffmpeg.
// =====================================================================
const { ejecutar } = require('./utiles');
const { elegirVentanas, repartirParejo } = require('./analisis');

const par = n => Math.max(2, Math.round(n / 2) * 2);   // ffmpeg necesita medidas pares

// Lee duración y tamaño real del video (cuenta si el celular lo grabó girado)
async function sondear(archivo) {
  const out = await ejecutar('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration',
    '-of', 'json', archivo,
  ], { timeoutMs: 60000 });
  const j = JSON.parse(out);
  const s = (j.streams || [])[0];
  const duracion = parseFloat(j.format && j.format.duration);
  if (!s || !duracion) throw new Error('No pude leer el video. ¿Es un archivo de video válido?');
  let ancho = s.width, alto = s.height;
  const lado = (s.side_data_list || []).find(d => 'rotation' in d);
  const giro = Math.abs(lado ? lado.rotation : 0);
  if (giro === 90 || giro === 270) [ancho, alto] = [alto, ancho];
  return { duracion, ancho, alto };
}

// Decide el segundo de inicio de cada clip.
//  modo 'parejo'  : repartidos a lo largo del tramo
//  modo 'mejores' : los momentos con más voz/movimiento (necesita "puntos" de analisis.js)
//  modo 'iguales' : el tramo dividido en N partes iguales, una detrás de otra
function calcularInicios({ desde = 0, hasta, modo, cantidad, duracion, puntos }) {
  const rango = hasta - desde;
  if (rango < 3) throw new Error('El tramo elegido es muy corto (mínimo 3 segundos).');

  if (modo === 'iguales') {
    const dur = Math.floor(rango / cantidad);
    if (dur < 3) throw new Error(`Con ${cantidad} partes, cada una duraría menos de 3 segundos. Baja la cantidad.`);
    return { inicios: Array.from({ length: cantidad }, (_, i) => desde + i * dur), dur, aviso: '' };
  }

  const dur = Math.min(duracion, Math.floor(rango));
  let aviso = '';
  if (modo === 'mejores') {
    const relativos = puntos && puntos.length ? elegirVentanas(puntos, dur, cantidad) : [];
    if (relativos.length) {
      if (relativos.length < cantidad) aviso = `Solo cabían ${relativos.length} clips sin repetir partes del video.`;
      return { inicios: relativos.map(s => desde + s), dur, aviso };
    }
    aviso = 'No pude medir los mejores momentos; los clips se repartieron parejo.';
  }
  return { inicios: repartirParejo(rango, dur, cantidad).map(s => desde + s), dur, aviso };
}

// Tamaño final del clip según el formato elegido
function dimensionesSalida(formato, ancho, alto) {
  if (formato === 'vertical') return { w: 1080, h: 1920 };
  if (formato === 'cuadrado') return { w: 1080, h: 1080 };
  const f = Math.min(1, 1920 / Math.max(ancho, alto));   // "original", sin pasar de Full HD
  return { w: par(ancho * f), h: par(alto * f) };
}

const TAMANOS_LOGO = { chico: 0.12, medio: 0.18, grande: 0.26 };
const POSICIONES_LOGO = ['tl', 'tr', 'bl', 'br', 'centro'];

// Arma la orden de ffmpeg para UN clip. (Función pura: se puede probar sin ejecutar nada.)
// logo = { ruta, posicion: 'tl'|'tr'|'bl'|'br'|'centro', tamano: 'chico'|'medio'|'grande' } o null
function construirArgs({ origen, inicio, dur, salida, formato, dims, logo }) {
  let cadena;
  if (formato === 'vertical') cadena = `crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',scale=${dims.w}:${dims.h}`;
  else if (formato === 'cuadrado') cadena = `crop='min(iw,ih)':'min(iw,ih)',scale=${dims.w}:${dims.h}`;
  else cadena = `scale=${dims.w}:${dims.h}`;
  cadena += ',setsar=1';

  const args = ['-nostdin', '-y', '-v', 'error', '-ss', String(inicio), '-i', origen];
  if (logo) args.push('-i', logo.ruta);
  args.push('-t', String(dur));

  if (logo) {
    const lw = par(dims.w * (TAMANOS_LOGO[logo.tamano] || TAMANOS_LOGO.medio));
    const m = Math.round(dims.w * 0.04);
    const posiciones = {
      tl: `${m}:${m}`,
      tr: `main_w-overlay_w-${m}:${m}`,
      bl: `${m}:main_h-overlay_h-${m}`,
      br: `main_w-overlay_w-${m}:main_h-overlay_h-${m}`,
      centro: '(main_w-overlay_w)/2:(main_h-overlay_h)/2',
    };
    const pos = posiciones[logo.posicion] || posiciones.br;
    args.push('-filter_complex',
      `[0:v]${cadena}[base];[1:v]scale=${lw}:-2,format=rgba,colorchannelmixer=aa=0.9[logo];` +
      `[base][logo]overlay=${pos},format=yuv420p[v]`,
      '-map', '[v]');
  } else {
    args.push('-vf', cadena + ',format=yuv420p', '-map', '0:v:0');
  }
  args.push('-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', salida);
  return args;
}

module.exports = { sondear, calcularInicios, dimensionesSalida, construirArgs, TAMANOS_LOGO, POSICIONES_LOGO };
