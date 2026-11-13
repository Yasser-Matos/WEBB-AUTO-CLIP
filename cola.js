// =====================================================================
// COLA DE TRABAJOS
// Si llegan más videos de los que el servidor aguanta a la vez, los demás
// esperan en fila (y la página les muestra su posición) en vez de dar error.
// =====================================================================
function crearCola({ maxActivos, maxEspera }) {
  const espera = [];             // trabajos esperando: { id, userId, correr }
  const enMarcha = new Map();    // trabajos corriendo: id -> userId

  // Si hay lugar libre, arranca el siguiente de la fila
  function avanzar() {
    while (enMarcha.size < maxActivos && espera.length) {
      const trabajo = espera.shift();
      enMarcha.set(trabajo.id, trabajo.userId);
      Promise.resolve()
        .then(trabajo.correr)
        .catch(() => {})                                 // los errores los maneja cada trabajo
        .finally(() => { enMarcha.delete(trabajo.id); avanzar(); });
    }
  }

  return {
    // Devuelve false si la fila está llena
    agregar(trabajo) {
      if (enMarcha.size >= maxActivos && espera.length >= maxEspera) return false;
      espera.push(trabajo);
      avanzar();
      return true;
    },
    // 0 = ya está corriendo; 1 = es el siguiente; 2 = hay uno antes, etc.
    posicion(id) {
      const i = espera.findIndex(t => t.id === id);
      return i < 0 ? 0 : i + 1;
    },
    // Cuántos trabajos tiene un usuario (corriendo + esperando)
    cantidadDe(userId) {
      return espera.filter(t => t.userId === userId).length +
             [...enMarcha.values()].filter(u => u === userId).length;
    },
    get activos() { return enMarcha.size; },
    get esperando() { return espera.length; },
  };
}

module.exports = { crearCola };
