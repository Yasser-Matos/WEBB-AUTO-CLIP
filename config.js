// =====================================================================
// CONFIGURACIÓN - aquí cambias precios, límites y planes
// Todo lo que está entre comillas o números lo puedes editar.
// Las claves secretas NO se escriben aquí: van en las "Variables" de Railway.
// =====================================================================
const path = require('path');

module.exports = {
  // ---- Servidor ----
  PUERTO: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'cambia-esta-clave-larga',   // ¡Ponla en Railway!
  ADMIN_KEY: process.env.ADMIN_KEY || '',                             // Clave para crear usuarios a mano
  // En Railway apunta esto a un "Volume" (ej. /data/data.db) o perderás los usuarios al redesplegar
  DB_PATH: process.env.DB_PATH || path.join(__dirname, 'data.db'),

  // ---- Límites generales (los planes pueden ser más bajos, nunca más altos) ----
  MAX_CLIPS: 20,                // máximo de clips por video
  MAX_DURACION_CLIP: 180,       // máximo de segundos por clip
  MAX_TAMANO_MB: 500,           // tamaño máximo del video subido
  MINUTOS_VIDA_CLIPS: 20,       // a los cuántos minutos se borran los clips
  MAX_LOGO_KB: 1024,            // tamaño máximo del logo

  // ---- Cola de trabajo ----
  MAX_TRABAJOS_A_LA_VEZ: 2,     // cuántos videos se procesan al mismo tiempo
  MAX_COLA: 20,                 // cuántos pueden esperar en fila
  MAX_TRABAJOS_POR_USUARIO: 2,  // cuántos videos a la vez puede tener un mismo usuario

  // ---- Ventas ----
  DIAS_POR_COMPRA: 30,          // cada pago da este número de días de acceso
  PLAN_POR_DEFECTO: 'basico',

  // ---- Prueba gratis ----
  // (También puedes cambiarla desde el panel /admin -> Planes y precios)
  PRUEBA: { activa: true, dias: 7 },   // activa: true/false · dias: cuántos días dura
  MAX_PRUEBAS_POR_IP_DIA: 2,           // máximo de pruebas nuevas por día desde la misma conexión

  // ---- Planes (cambia nombres, precios en dólares y límites) ----
  PLANES: {
    // El plan de la prueba gratis: sus videos cuentan EN TOTAL (no por mes). No se vende.
    prueba: {
      nombre: 'Prueba gratis',
      esPrueba: true,
      precioUSD: 0,
      videosPorMes: 3,      // en la prueba: videos EN TOTAL
      maxClips: 5,
      maxDuracion: 30,
      logo: false,
      publicar: false,
    },
    basico: {
      nombre: 'Básico',
      precioUSD: 9.99,
      videosPorMes: 10,     // videos que puede procesar al mes
      maxClips: 10,         // clips por video
      maxDuracion: 60,      // segundos por clip
      logo: false,          // puede poner su logo/marca de agua
      publicar: false,      // puede publicar directo en redes
    },
    pro: {
      nombre: 'Pro',
      precioUSD: 19.99,
      videosPorMes: 100,
      maxClips: 20,
      maxDuracion: 180,
      logo: true,
      publicar: true,
    },
  },
};
