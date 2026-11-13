// =====================================================================
// ANÁLISIS - encuentra los "mejores momentos" de un video
//
// Idea: un momento es bueno si hay voz/ruido fuerte (la gente habla, ríe,
// hay música alta) y si hay movimiento o cambios de escena.
// Se mide cada segundo con ffmpeg (sin programas extra) y se eligen las
// ventanas con mejor puntaje, sin que se pisen entre sí.
// =====================================================================
const { ejecutar } = require('./utiles');

const LIMITE_ANALISIS_MS = 5 * 60 * 1000;   // si el análisis tarda más de 5 min, se cancela

// Devuelve una lista con un puntaje (0 a 1) por cada segundo entre "inicio" y "fin".
// Devuelve null si no se pudo medir nada (entonces se reparten los clips parejo).
async function puntuacionesPorSegundo(archivo, inicio, fin) {
  const n = Math.max(0, Math.floor(fin - inicio));
  const audio = new Array(n).fill(0);
  const mov = new Array(n).fill(0);
  let hayAudio = false, hayMov = false;

  // 1) Volumen del audio por segundo (RMS en decibeles)
  try {
    const out = await ejecutar('ffmpeg', [
      '-nostdin', '-v', 'error', '-ss', String(inicio), '-t', String(fin - inicio), '-i', archivo, '-vn',
      '-af', 'aresample=8000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
      '-f', 'null', '-',
    ], { timeoutMs: LIMITE_ANALISIS_MS });
    let i = 0;
    for (const linea of out.split('\n')) {
      const m = linea.match(/lavfi\.astats\.Overall\.RMS_level=(-?inf|-?[\d.]+)/i);
      if (!m) continue;
      const db = /inf/i.test(m[1]) ? -90 : parseFloat(m[1]);
      if (i < n) audio[i] = Math.min(1, Math.max(0, (db + 60) / 60));   // -60 dB => 0, 0 dB => 1
      i++;
    }
    hayAudio = i > 0;
  } catch { /* video sin audio: seguimos solo con movimiento */ }

  // 2) Cambios de escena / movimiento (2 fotogramas por segundo, en miniatura para ir rápido)
  //    En tramos de más de 20 minutos se omite (tardaría demasiado) y se usa solo el audio.
  if (fin - inicio <= 1200) try {
    const out = await ejecutar('ffmpeg', [
      '-nostdin', '-v', 'error', '-ss', String(inicio), '-t', String(fin - inicio), '-i', archivo, '-an',
      '-vf', "fps=2,scale=160:-2,select='gt(scene,0.2)',metadata=print:file=-",
      '-f', 'null', '-',
    ], { timeoutMs: LIMITE_ANALISIS_MS });
    let t = null;
    for (const linea of out.split('\n')) {
      const mt = linea.match(/pts_time:([\d.]+)/);
      if (mt) t = parseFloat(mt[1]);
      const ms = linea.match(/lavfi\.scene_score=([\d.]+)/);
      if (ms && t !== null) {
        const s = Math.floor(t);
        if (s >= 0 && s < n) mov[s] = Math.min(1, mov[s] + parseFloat(ms[1]));
      }
    }
    hayMov = true;
  } catch { /* sin datos de movimiento */ }

  if (!hayAudio && !hayMov) return null;

  // 3) Mezcla (voz/sonido pesa más) y suavizado de 3 segundos
  const mezcla = audio.map((a, i) => hayAudio && hayMov ? 0.7 * a + 0.3 * mov[i] : hayAudio ? a : mov[i]);
  return mezcla.map((_, i) => {
    const vecinos = mezcla.slice(Math.max(0, i - 1), i + 2);
    return vecinos.reduce((x, y) => x + y, 0) / vecinos.length;
  });
}

// Elige las "cantidad" mejores ventanas de "dur" segundos que no se pisen.
// Devuelve los segundos de inicio (en orden). Puede devolver menos de las pedidas
// si el video no da espacio.  (Función pura: fácil de probar.)
function elegirVentanas(puntos, dur, cantidad) {
  const n = puntos.length;
  if (n < dur || dur < 1) return [];
  const suma = [0];
  for (const p of puntos) suma.push(suma[suma.length - 1] + p);
  const ventana = s => (suma[s + dur] - suma[s]) / dur;

  const elegidos = [];
  for (let k = 0; k < cantidad; k++) {
    let mejor = -1, mejorPuntaje = -1;
    for (let s = 0; s <= n - dur; s++) {
      if (elegidos.some(e => Math.abs(e - s) < dur)) continue;   // no pisar otro clip
      const p = ventana(s);
      if (p > mejorPuntaje) { mejorPuntaje = p; mejor = s; }
    }
    if (mejor < 0) break;
    elegidos.push(mejor);
  }
  return elegidos.sort((a, b) => a - b);
}

// Reparte los clips parejo a lo largo del video (permite que se solapen si hace falta)
function repartirParejo(total, dur, cantidad) {
  const espacio = cantidad > 1 ? Math.max(0, (total - dur) / (cantidad - 1)) : 0;
  return Array.from({ length: cantidad }, (_, i) => Math.min(i * espacio, Math.max(0, total - dur)));
}

module.exports = { puntuacionesPorSegundo, elegirVentanas, repartirParejo };
