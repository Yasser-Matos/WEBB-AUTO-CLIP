// =====================================================================
// ZIP - arma un .zip con todos los clips para descargarlos de una vez.
// Sin librerías extra: los MP4 ya vienen comprimidos, así que el zip solo los "empaqueta".
// =====================================================================
const fs = require('fs');
const { pipeline } = require('stream/promises');

// Tabla para calcular el CRC32 que exige el formato zip
const TABLA = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crcArchivo(ruta) {
  return new Promise((resolve, reject) => {
    let crc = 0xFFFFFFFF;
    fs.createReadStream(ruta)
      .on('data', buf => { for (let i = 0; i < buf.length; i++) crc = TABLA[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8); })
      .on('end', () => resolve((crc ^ 0xFFFFFFFF) >>> 0))
      .on('error', reject);
  });
}

function fechaDos(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// archivos = [{ nombre: 'clip_1.mp4', ruta: '/ruta/real/clip_1.mp4' }, ...]
async function escribirZip(res, archivos, nombreZip) {
  const items = [];
  for (const a of archivos) {
    items.push({ nombre: Buffer.from(a.nombre, 'utf8'), ruta: a.ruta, tam: fs.statSync(a.ruta).size, crc: await crcArchivo(a.ruta) });
  }
  const { time, date } = fechaDos(new Date());

  // Preparamos las cabeceras para conocer el tamaño total exacto
  const cabeceras = [], centrales = [];
  let offset = 0;
  for (const it of items) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(it.crc, 14);
    h.writeUInt32LE(it.tam, 18); h.writeUInt32LE(it.tam, 22); h.writeUInt16LE(it.nombre.length, 26); h.writeUInt16LE(0, 28);
    cabeceras.push(h);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(it.crc, 16);
    c.writeUInt32LE(it.tam, 20); c.writeUInt32LE(it.tam, 24); c.writeUInt16LE(it.nombre.length, 28);
    c.writeUInt32LE(offset, 42);
    centrales.push(c);
    offset += 30 + it.nombre.length + it.tam;
  }
  const tamCentral = items.reduce((s, it) => s + 46 + it.nombre.length, 0);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(items.length, 8); fin.writeUInt16LE(items.length, 10);
  fin.writeUInt32LE(tamCentral, 12); fin.writeUInt32LE(offset, 16);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreZip}"`);
  res.setHeader('Content-Length', offset + tamCentral + 22);

  const escribir = buf => new Promise(ok => (res.write(buf) ? ok() : res.once('drain', ok)));
  for (let i = 0; i < items.length; i++) {
    await escribir(cabeceras[i]);
    await escribir(items[i].nombre);
    await pipeline(fs.createReadStream(items[i].ruta), res, { end: false });
  }
  for (let i = 0; i < items.length; i++) { await escribir(centrales[i]); await escribir(items[i].nombre); }
  res.end(fin);
}

module.exports = { escribirZip };
