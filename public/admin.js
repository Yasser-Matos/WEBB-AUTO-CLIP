// =====================================================================
// PANEL DE ADMINISTRACIÓN - lo que pasa cuando tocas los botones
// Pantallas: Inicio, Usuarios, Ventas, Planes y precios, Sistema.
// =====================================================================
'use strict';

const $ = id => document.getElementById(id);

// Crea un elemento HTML de forma segura (usa textContent, nunca texto como código)
function el(tag, props = {}, ...hijos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const h of hijos.flat()) if (h != null) e.append(h);
  return e;
}

// ---------------------- Formatos ----------------------
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const usd0 = n => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');   // sin centavos, para etiquetas de gráficas
const usd = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const parseUtc = s => new Date(String(s).replace(' ', 'T') + 'Z');

// "12 nov" (con el año si no es el actual). Acepta 'AAAA-MM-DD' o 'AAAA-MM-DD HH:MM:SS'
function fecha(iso) {
  const [a, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${d} ${MESES[m - 1]}` + (a !== new Date().getFullYear() ? ` ${a}` : '');
}
function hace(iso) {
  const dias = Math.floor((Date.now() - parseUtc(iso)) / 86400000);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  return dias < 30 ? `hace ${dias} días` : fecha(iso);
}
function enDias(n) {                       // "en 3 días", "mañana", "hace 2 días"
  if (n === 0) return 'hoy';
  if (n === 1) return 'mañana';
  if (n === -1) return 'ayer';
  return n > 0 ? `en ${n} días` : `hace ${-n} días`;
}
const mesCorto = ym => MESES[Number(ym.slice(5, 7)) - 1];
const METODOS = { stripe: 'Tarjeta (Stripe)', paypal: 'PayPal', efectivo: 'Efectivo', transferencia: 'Transferencia', otro: 'Otro' };
const ESTADOS = { activo: ['Activo', 'ok'], prueba: ['En prueba', 'prueba'], vencido: ['Vencido', 'vencido'], bloqueado: ['Bloqueado', 'bloqueado'] };

const est = {
  planes: {},            // planes y precios actuales
  prueba: { activa: true, dias: 7 },
  pagina: 'inicio',
  navId: 0,              // evita que una pantalla lenta pise a otra
  resumen: null,
  filtroUsu: { q: '', estado: '', plan: '', pagina: 1 },
  recargarUsuarios: null,
};
const nombrePlan = id => (est.planes[id] || {}).nombre || id;
const pillPlan = id => el('span', { class: 'pill plan' + (id === 'pro' ? ' pro' : ''), text: nombrePlan(id) });
const pillEstado = estado => el('span', { class: 'pill ' + ESTADOS[estado][1], text: ESTADOS[estado][0] });

// ---------------------- Servidor ----------------------
async function api(url, { method = 'GET', cuerpo } = {}) {
  const r = await fetch(url, {
    method, headers: cuerpo ? { 'Content-Type': 'application/json' } : undefined, body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  let datos = {};
  try { datos = await r.json(); } catch { /* sin cuerpo */ }
  if (r.status === 401 && url !== '/api/admin/login') { mostrarLogin(); throw new Error('sesion'); }
  if (!r.ok) throw new Error(datos.error || 'Algo salió mal. Intenta de nuevo.');
  return datos;
}

// Ejecuta una acción, desactiva el botón mientras tanto y muestra el error si falla
async function intentar(boton, fn) {
  if (boton) boton.disabled = true;
  try { return await fn(); }
  catch (e) { if (e.message !== 'sesion') toast(e.message, 'error'); return null; }
  finally { if (boton) boton.disabled = false; }
}

let relojToast = null;
function toast(texto, tipo = 'ok') {
  const t = $('toast');
  t.textContent = texto; t.className = 'toast ' + tipo;
  clearTimeout(relojToast);
  relojToast = setTimeout(() => t.classList.add('oculto'), 5000);
}

async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); toast('Copiado'); }
  catch { toast('No se pudo copiar. Selecciona el texto y cópialo a mano.', 'error'); }
}

function generarClave() {
  const letras = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin letras que se confunden
  const b = new Uint32Array(10); crypto.getRandomValues(b);
  return Array.from(b, x => letras[x % letras.length]).join('');
}

// Pregunta "¿seguro?" antes de algo que no se puede deshacer
function confirmar({ titulo, texto, boton, peligro = true }) {
  return new Promise(resolver => {
    const d = $('dlgConfirmar');
    const cerrar = valor => { d.close(); resolver(valor); };
    d.replaceChildren(el('div', { class: 'modal-interior' },
      el('h2', { id: 'confTitulo', text: titulo }),
      el('p', { class: 'suave', style: 'margin-top:8px', text: texto }),
      el('div', { class: 'modal-acciones' },
        el('button', { type: 'button', class: 'btn sec', text: 'Cancelar', onclick: () => cerrar(false) }),
        el('button', { type: 'button', class: 'btn' + (peligro ? ' peligro' : ''), text: boton, onclick: () => cerrar(true) }))));
    d.addEventListener('close', () => resolver(false), { once: true });
    d.showModal();
  });
}
for (const id of ['dlgFicha', 'dlgNuevo', 'dlgConfirmar']) {
  $(id).addEventListener('click', e => { if (e.target === $(id)) $(id).close(); });   // clic fuera = cerrar
}

// ======================================================================
//  ENTRADA Y MENÚ
// ======================================================================
const ICONOS = {
  inicio: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  usuarios: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14.5c2.4.2 4 1.8 4.5 4.5"/>',
  ventas: '<circle cx="12" cy="12" r="9"/><path d="M14.6 9.2c-.5-.8-1.4-1.2-2.6-1.2-1.4 0-2.5.7-2.5 1.8 0 2.6 5.2 1.2 5.2 3.9 0 1.2-1.2 2-2.7 2-1.2 0-2.2-.5-2.7-1.4M12 6.4V8m0 8v1.6"/>',
  planes: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
  sistema: '<path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
};
const PAGINAS = {
  inicio: { menu: 'Inicio', cargar: paginaInicio },
  usuarios: { menu: 'Usuarios', cargar: paginaUsuarios },
  ventas: { menu: 'Ventas', cargar: paginaVentas },
  planes: { menu: 'Planes y precios', cargar: paginaPlanes },
  sistema: { menu: 'Estado del sistema', cargar: paginaSistema },
};

function construirMenu() {
  $('menu').replaceChildren(...Object.entries(PAGINAS).map(([id, p]) => {
    const a = el('a', { href: '#' + id, 'data-pag': id });
    a.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONOS[id]}</svg>`;
    a.append(p.menu);
    if (id === 'sistema') a.append(el('span', { class: 'punto oculto', id: 'puntoSistema' }));
    return a;
  }));
}
function ponerPuntoSistema(n) {
  const p = $('puntoSistema');
  if (!p) return;
  p.textContent = n; p.classList.toggle('oculto', !n);
  p.setAttribute('aria-label', plural(n, 'cosa por configurar', 'cosas por configurar'));
}

function mostrarLogin() {
  $('vistaPanel').classList.add('oculto'); $('vistaLogin').classList.remove('oculto');
  $('claveAdmin').focus();
}
$('formLogin').addEventListener('submit', async e => {
  e.preventDefault();
  $('btnLogin').disabled = true; $('errLogin').textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', cuerpo: { clave: $('claveAdmin').value } });
    $('claveAdmin').value = '';
    await abrirPanel();
  } catch (err) { $('errLogin').textContent = err.message; }
  $('btnLogin').disabled = false;
});
$('btnSalir').onclick = async () => { await fetch('/api/admin/logout', { method: 'POST' }); location.hash = ''; mostrarLogin(); };

// Tema claro / oscuro (se recuerda en este navegador)
function aplicarTema(t) {
  if (t) document.documentElement.dataset.tema = t; else delete document.documentElement.dataset.tema;
  const oscuro = (t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'oscuro' : 'claro')) === 'oscuro';
  $('btnTema').textContent = oscuro ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
}
try { aplicarTema(localStorage.getItem('vc_tema_admin')); } catch { aplicarTema(null); }
$('btnTema').onclick = () => {
  const oscuroAhora = document.documentElement.dataset.tema === 'oscuro' ||
    (!document.documentElement.dataset.tema && matchMedia('(prefers-color-scheme: dark)').matches);
  const nuevo = oscuroAhora ? 'claro' : 'oscuro';
  try { localStorage.setItem('vc_tema_admin', nuevo); } catch { /* nada */ }
  aplicarTema(nuevo);
};

async function abrirPanel() {
  const [planes] = await Promise.all([api('/api/admin/planes')]);
  est.planes = planes.planes; est.prueba = planes.prueba; est.maximos = planes.maximos; est.diasPorCompra = planes.diasPorCompra;
  $('vistaLogin').classList.add('oculto'); $('vistaPanel').classList.remove('oculto');
  construirMenu();
  ir(location.hash.slice(1));
  api('/api/admin/resumen').then(r => { est.resumen = r; ponerPuntoSistema(r.porConfigurar); }).catch(() => {});
}

// Cambiar de pantalla
window.addEventListener('hashchange', () => { if (!$('vistaPanel').classList.contains('oculto')) ir(location.hash.slice(1)); });
async function ir(id) {
  if (!PAGINAS[id]) id = 'inicio';
  est.pagina = id; est.recargarUsuarios = null;
  const miNav = ++est.navId;
  document.querySelectorAll('#menu a').forEach(a => { if (a.dataset.pag === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('accionesPag').replaceChildren();
  const cont = $('pagina');
  cont.replaceChildren(el('p', { class: 'suave', text: 'Cargando...' }));
  try { await PAGINAS[id].cargar(cont, () => miNav === est.navId); }
  catch (e) { if (e.message !== 'sesion' && miNav === est.navId) cont.replaceChildren(el('div', { class: 'tarjeta vacio' }, el('h3', { text: 'No se pudo cargar esta pantalla' }), el('p', { text: e.message }), el('button', { type: 'button', class: 'btn', text: 'Intentar de nuevo', onclick: () => ir(id) }))); }
}
function titulo(texto, sub) {
  $('tituloPag').textContent = texto; $('subPag').textContent = sub; document.title = `${texto} - Panel de VideoClips`;
}

// ======================================================================
//  PIEZAS REUTILIZABLES
// ======================================================================
function barras({ datos, clave, formato, dinero, vacio }) {
  const max = Math.max(0, ...datos.map(d => d[clave]));
  if (!max) return el('p', { class: 'vacio-chico', text: vacio });
  return el('div', { class: 'barras', role: 'img', 'aria-label': datos.map(d => `${mesCorto(d.mes)}: ${formato(d[clave])}`).join(', ') },
    datos.map((d, i) => el('div', { class: 'barra-col' },
      el('span', { class: 'barra-valor' + (d[clave] ? '' : ' cero'), text: d[clave] ? formato(d[clave]) : '0' }),
      el('div', { class: 'barra-pista' }, el('div', { class: 'barra-rel' + (dinero ? ' dinero' : '') + (i === datos.length - 1 ? ' actual' : ''), style: `height:${Math.max(3, (d[clave] / max) * 100)}%` })),
      el('span', { class: 'barra-mes', text: mesCorto(d.mes) }))));
}
const tarjetaGrafica = (titulo, sub, cuerpo) => el('section', { class: 'tarjeta' }, el('h2', { text: titulo }), el('p', { class: 'suave', text: sub }), cuerpo);
const mailto = (email, asunto, cuerpo) => `mailto:${email}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;

// Acción rápida sobre un usuario desde las listas (sin abrir la ficha)
async function accionRapida(id, accion, valor, boton) {
  const r = await intentar(boton, () => api(`/api/admin/usuarios/${id}/accion`, { method: 'POST', cuerpo: { accion, valor } }));
  if (r) { toast(r.mensaje); est.resumen = null; ir(est.pagina); }
}

// ======================================================================
//  INICIO
// ======================================================================
async function paginaInicio(cont, vigente) {
  const r = await api('/api/admin/resumen');
  if (!vigente()) return;
  est.resumen = r; ponerPuntoSistema(r.porConfigurar);
  const h = new Date().getHours();
  titulo(h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches', 'Así va VideoClips hoy: tus ventas, quién lo usa y a quién avisarle.');

  const aviso = r.porConfigurar > 0
    ? el('div', { class: 'aviso-grande' },
        el('span', { text: `Hay ${plural(r.porConfigurar, 'cosa', 'cosas')} por configurar para que todo funcione bien.` }),
        el('a', { class: 'btn peq sec', href: '#sistema', text: 'Ver qué falta' }))
    : null;

  cont.replaceChildren(...[
    aviso,
    el('div', { class: 'rejilla inicio' }, ticketCaja(r), tarjetaPersonas(r)),
    el('div', { class: 'rejilla mitad' },
      tarjetaGrafica('Dinero cobrado por mes', 'Lo que entró en los últimos 6 meses.',
        barras({ datos: r.mensual, clave: 'ingresos', formato: usd0, dinero: true, vacio: 'Aquí verás cuánto dinero entra cada mes.' })),
      tarjetaGrafica('Personas nuevas por mes', 'Cuántas se registraron (prueba o compra).',
        barras({ datos: r.mensual, clave: 'registros', formato: n => String(n), vacio: 'Aquí verás cuánta gente nueva llega cada mes.' }))),
    el('div', { class: 'rejilla mitad' }, tarjetaPorVencer(r), tarjetaPruebas(r)),
  ].filter(Boolean));
}

// La caja: ticket con lo cobrado y las últimas ventas
function ticketCaja(r) {
  const v = r.ingresos;
  const lineas = r.ultimasVentas.length
    ? r.ultimasVentas.flatMap(x => [
        el('div', { class: 'ticket-linea' }, el('span', { class: 'quien', text: x.email }), el('span', { class: 'puntos' }), el('span', { class: 'monto', text: '+' + usd(x.monto) })),
        el('div', { class: 'ticket-detalle', text: `${nombrePlan(x.plan)}, ${METODOS[x.proveedor] || x.proveedor}, ${hace(x.pagadoEn)}` }),
      ])
    : [el('p', { class: 'vacio', text: 'Todavía no hay ventas. Cada vez que alguien compre un plan, se anota aquí con su monto.' })];
  return el('section', { class: 'ticket', 'aria-label': 'La caja' },
    el('h2', { text: 'La caja de este mes' }),
    el('span', { class: 'ticket-total', text: usd(v.mes) }),
    el('p', { class: 'ticket-sub', text: v.pagosMes ? plural(v.pagosMes, 'venta cobrada', 'ventas cobradas') : 'Todavía no hay ventas este mes' }),
    el('hr'), ...lineas, el('hr'),
    el('div', { class: 'ticket-acumulado' }, el('span', { text: 'Total guardado hasta hoy' }), el('b', { text: usd(v.total) })),
    el('p', { class: 'caja-pie' }, el('a', { href: '#ventas', text: 'Ver todas las ventas' })));
}

// Cuánta gente lo usa y qué plan tiene
function tarjetaPersonas(r) {
  const u = r.usuarios;
  const ver = estado => () => { est.filtroUsu = { q: '', estado, plan: '', pagina: 1 }; location.hash = '#usuarios'; };
  const ficha = (n, txt, estado) => el('button', { type: 'button', class: 'ficha-num', onclick: ver(estado) }, el('b', { text: n }), el('span', { text: txt }));
  const ids = Object.keys(r.planes);
  const maximo = Math.max(1, ...ids.map(id => r.porPlan[id] || 0));
  return el('section', { class: 'tarjeta' },
    el('h2', { text: 'Personas' }),
    el('div', { class: 'gran-cifra' },
      el('b', { text: u.usaronEsteMes }),
      el('span', { class: 'suave', text: `${u.usaronEsteMes === 1 ? 'persona usó' : 'personas usaron'} la web este mes, de ${plural(u.total, 'registrada', 'registradas')}` })),
    el('div', { class: 'fichas' },
      ficha(u.activos, 'Con plan activo', 'activo'), ficha(u.pruebas, 'En prueba gratis', 'prueba'),
      ficha(u.vencidos, 'Vencidos', 'vencido'), ficha(u.bloqueados, 'Bloqueados', 'bloqueado')),
    el('h3', { text: 'Qué plan tienen ahora' }),
    el('div', { class: 'reparto', style: 'margin-top:12px' }, ids.map(id => el('div', { class: 'reparto-fila' },
      el('div', {}, el('span', { class: 'nombre', text: r.planes[id].nombre }), el('small', { text: r.planes[id].precioUSD ? `${usd(r.planes[id].precioUSD)} por compra` : 'Gratis' })),
      el('div', { class: 'reparto-pista' }, el('div', { class: 'reparto-barra ' + id, style: `width:${((r.porPlan[id] || 0) / maximo) * 100}%` })),
      el('span', { class: 'n', text: r.porPlan[id] || 0 })))),
    el('p', { class: 'suave', style: 'margin:18px 0 0', text: `${plural(u.nuevosSemana, 'persona nueva', 'personas nuevas')} esta semana y ${plural(r.videosMes, 'video procesado', 'videos procesados')} este mes.` }));
}

function tarjetaPorVencer(r) {
  const filas = r.porVencer.map(u => el('div', { class: 'lista-fila' },
    el('div', { class: 'quien' }, el('b', { text: u.email }), el('small', { text: `${nombrePlan(u.plan)}, vence ${enDias(u.diasRestantes)} (${fecha(u.vence)})` })),
    el('div', { class: 'botones' },
      el('button', { type: 'button', class: 'btn sec peq', text: 'Sumar 30 días', onclick: e => accionRapida(u.id, 'sumar_dias', 30, e.currentTarget) }),
      el('a', { class: 'btn sec peq', text: 'Escribirle', href: mailto(u.email, 'Tu acceso a VideoClips vence pronto',
        `Hola, tu plan ${nombrePlan(u.plan)} de VideoClips vence el ${fecha(u.vence)}. Para renovarlo entra a ${location.origin} y elige "Mejorar o renovar".`) }))));
  return el('section', { class: 'tarjeta' }, el('h2', { text: 'Planes que vencen esta semana' }), el('p', { class: 'suave', text: 'Avísales a tiempo para que no se vayan.' }),
    filas.length ? el('div', { class: 'lista' }, filas) : el('p', { class: 'vacio-chico', text: 'Nadie vence en los próximos 7 días.' }));
}
function tarjetaPruebas(r) {
  const filas = r.pruebasPorTerminar.map(u => el('div', { class: 'lista-fila' },
    el('div', { class: 'quien' }, el('b', { text: u.email }), el('small', { text: `La prueba termina ${enDias(u.diasRestantes)}` })),
    el('div', { class: 'botones' },
      el('a', { class: 'btn sec peq', text: 'Ofrecerle un plan', href: mailto(u.email, 'Tu prueba gratis de VideoClips está por terminar',
        `Hola, tu prueba gratis de VideoClips termina el ${fecha(u.vence)}. Si te gustó, puedes elegir un plan aquí: ${location.origin}`) }))));
  return el('section', { class: 'tarjeta' }, el('h2', { text: 'Pruebas por terminar' }), el('p', { class: 'suave', text: 'Buen momento para ofrecerles un plan.' }),
    filas.length ? el('div', { class: 'lista' }, filas) : el('p', { class: 'vacio-chico', text: 'No hay pruebas por terminar en los próximos 2 días.' }));
}

// ======================================================================
//  USUARIOS
// ======================================================================
async function paginaUsuarios(cont, vigente) {
  titulo('Usuarios', 'Todas las personas con cuenta. Toca una para ver o cambiar lo que quieras.');
  $('accionesPag').replaceChildren(el('button', { type: 'button', class: 'btn', text: 'Nuevo usuario', onclick: abrirNuevo }));
  if (!est.resumen) { try { est.resumen = await api('/api/admin/resumen'); } catch (e) { if (e.message === 'sesion') throw e; } }
  if (!vigente()) return;

  const f = est.filtroUsu;
  const cuenta = est.resumen ? est.resumen.usuarios : null;
  const opciones = [['', 'Todos', cuenta && cuenta.total], ['activo', 'Con plan', cuenta && cuenta.activos], ['prueba', 'En prueba', cuenta && cuenta.pruebas],
    ['vencido', 'Vencidos', cuenta && cuenta.vencidos], ['bloqueado', 'Bloqueados', cuenta && cuenta.bloqueados]];

  const buscar = el('input', { type: 'search', class: 'buscar', placeholder: 'Buscar por correo', 'aria-label': 'Buscar por correo', value: f.q });
  const selPlan = el('select', { 'aria-label': 'Filtrar por plan', style: 'width:auto' },
    el('option', { value: '', text: 'Todos los planes' }),
    Object.entries(est.planes).map(([id, p]) => el('option', { value: id, text: p.nombre, selected: id === f.plan || undefined })));
  const chips = el('div', { class: 'filtros', role: 'group', 'aria-label': 'Filtrar por estado' });
  const caja = el('div', {});

  const pintarChips = () => chips.replaceChildren(...opciones.map(([v, txt, n]) => el('button', {
    type: 'button', 'aria-pressed': String(f.estado === v), onclick: () => { f.estado = v; f.pagina = 1; pintarChips(); cargar(); },
  }, txt, n != null ? el('span', { text: n }) : null)));

  async function cargar() {
    const q = new URLSearchParams({ q: f.q, estado: f.estado, plan: f.plan, pagina: f.pagina });
    const d = await api('/api/admin/usuarios?' + q);
    if (!vigente()) return;
    pintar(d);
  }
  est.recargarUsuarios = () => { est.resumen = null; cargar(); };

  function pintar(d) {
    if (!d.usuarios.length) {
      caja.replaceChildren(el('div', { class: 'tabla-caja vacio' },
        el('h3', { text: 'No hay personas con esos filtros' }),
        el('p', { text: 'Prueba con otra búsqueda, o crea un usuario nuevo para regalarle o venderle acceso.' }),
        el('button', { type: 'button', class: 'btn', text: 'Nuevo usuario', onclick: abrirNuevo })));
      return;
    }
    const desde = (d.pagina - 1) * d.porPagina + 1, hasta = desde + d.usuarios.length - 1;
    const filas = d.usuarios.map(u => {
      const esPrueba = u.plan === 'prueba';
      const limite = (est.planes[u.plan] || {}).videosPorMes || 0;
      const usado = esPrueba ? u.usoTotal : u.usoMes;
      return el('tr', { class: 'clic', onclick: () => abrirFicha(u) },
        el('td', { 'data-etiqueta': 'Persona' }, el('div', { class: 'persona' }, el('b', { text: u.email }), el('small', { text: `Se unió el ${fecha(u.creado)}` }))),
        el('td', { 'data-etiqueta': 'Plan' }, pillPlan(u.plan)),
        el('td', { 'data-etiqueta': 'Estado' }, pillEstado(u.estado), el('div', {}, el('small', { text: u.estado === 'bloqueado' ? 'No puede entrar' : `${u.diasRestantes >= 0 ? 'Vence' : 'Venció'} ${enDias(u.diasRestantes)}` }))),
        el('td', { 'data-etiqueta': esPrueba ? 'Videos de la prueba' : 'Videos este mes' }, el('div', { class: 'mini-uso' },
          el('div', { class: 'pista' }, el('div', { class: usado >= limite && limite ? 'lleno' : '', style: `width:${limite ? Math.min(100, (usado / limite) * 100) : 0}%` })),
          el('span', { text: `${usado} de ${limite}` }))),
        el('td', {}, el('button', { type: 'button', class: 'btn sec peq', text: 'Gestionar', 'aria-label': `Gestionar a ${u.email}`, onclick: ev => { ev.stopPropagation(); abrirFicha(u); } })));
    });
    const ultima = Math.ceil(d.total / d.porPagina);
    caja.replaceChildren(el('div', { class: 'tabla-caja' },
      el('table', { class: 'tabla' },
        el('thead', {}, el('tr', {}, ['Persona', 'Plan', 'Estado', 'Uso', ''].map(t => el('th', { scope: 'col', text: t })))),
        el('tbody', {}, filas)),
      el('div', { class: 'pie-tabla' },
        el('span', { class: 'suave', text: `Mostrando ${desde} a ${hasta} de ${plural(d.total, 'persona', 'personas')}` }),
        el('div', { class: 'botones-fila' },
          el('button', { type: 'button', class: 'btn sec peq', text: 'Anterior', disabled: d.pagina <= 1, onclick: () => { f.pagina--; cargar(); } }),
          el('button', { type: 'button', class: 'btn sec peq', text: 'Siguiente', disabled: d.pagina >= ultima, onclick: () => { f.pagina++; cargar(); } })))));
  }

  let espera = null;
  buscar.addEventListener('input', () => { clearTimeout(espera); espera = setTimeout(() => { f.q = buscar.value.trim(); f.pagina = 1; cargar(); }, 250); });
  selPlan.addEventListener('change', () => { f.plan = selPlan.value; f.pagina = 1; cargar(); });

  pintarChips();
  cont.replaceChildren(el('div', { class: 'barra-herramientas' }, buscar, selPlan), el('div', { class: 'barra-herramientas' }, chips), caja);
  await cargar();
}

// ---------------------- Ficha de un usuario ----------------------
function abrirFicha(u) {
  const dlg = $('dlgFicha');
  const abiertos = { cuenta: false, delicada: false };

  async function ejecutar(accion, valor, boton) {
    const r = await intentar(boton, () => api(`/api/admin/usuarios/${u.id}/accion`, { method: 'POST', cuerpo: { accion, valor } }));
    if (!r) return null;
    if (r.usuario) Object.assign(u, r.usuario);
    toast(r.mensaje);
    est.resumen = null;
    pintar();
    if (est.recargarUsuarios) est.recargarUsuarios();
    return r;
  }
  const boton = (texto, fn, clase = 'btn sec peq') => el('button', { type: 'button', class: clase, text: texto, onclick: e => fn(e.currentTarget) });

  function pintar() {
    const plan = est.planes[u.plan] || { nombre: u.plan, videosPorMes: 0 };
    const esPrueba = u.plan === 'prueba';
    const usado = esPrueba ? u.usoTotal : u.usoMes;

    // --- Dar más tiempo ---
    const inDias = el('input', { type: 'number', id: 'fDias', min: 1, max: 3650, inputmode: 'numeric', placeholder: 'Ej. 15' });
    const inFecha = el('input', { type: 'date', id: 'fFecha', value: u.vence });
    const tiempo = el('section', { class: 'bloque' },
      el('h3', { text: 'Dar más tiempo' }),
      el('p', { class: 'suave', text: 'Los días se suman a los que le queden.' }),
      el('div', { class: 'botones-fila' }, [7, 30, 90].map(n => boton(`Sumar ${n} días`, b => ejecutar('sumar_dias', n, b)))),
      el('label', { for: 'fDias', text: 'O escribe cuántos días' }),
      el('div', { class: 'campo-fila' }, inDias, boton('Sumar', b => ejecutar('sumar_dias', Number(inDias.value), b))),
      el('label', { for: 'fFecha', text: 'O elige la fecha exacta en que vence' }),
      el('div', { class: 'campo-fila' }, inFecha, boton('Guardar fecha', b => ejecutar('fijar_vence', inFecha.value, b))));

    // --- Plan ---
    const selPlan = el('select', { id: 'fPlan' }, Object.entries(est.planes).map(([id, p]) => el('option', { value: id, text: p.nombre, selected: id === u.plan || undefined })));
    const bloquePlan = el('section', { class: 'bloque' },
      el('h3', { text: 'Plan' }),
      el('p', { class: 'suave', text: 'Cambia el plan sin cobrar. Para anotar un pago, usa la sección de abajo.' }),
      el('div', { class: 'campo-fila' }, selPlan, boton('Guardar plan', b => ejecutar('cambiar_plan', selPlan.value, b))));

    // --- Cobrar y renovar ---
    const pagos = Object.entries(est.planes).filter(([, p]) => !p.esPrueba);
    const cPlan = el('select', { id: 'cPlan' }, pagos.map(([id, p]) => el('option', { value: id, text: `${p.nombre} (${usd(p.precioUSD)})`, selected: id === u.plan || undefined })));
    if (![...cPlan.options].some(o => o.selected)) cPlan.selectedIndex = pagos.length - 1;
    const cMonto = el('input', { type: 'number', id: 'cMonto', min: 0, step: '0.01', inputmode: 'decimal' });
    const cDias = el('input', { type: 'number', id: 'cDias', min: 1, max: 3650, value: est.diasPorCompra || 30, inputmode: 'numeric' });
    const cMetodo = el('select', { id: 'cMetodo' }, ['efectivo', 'transferencia', 'otro'].map(m => el('option', { value: m, text: METODOS[m] })));
    const precioDe = () => (est.planes[cPlan.value] || {}).precioUSD || 0;
    cMonto.value = precioDe().toFixed(2);
    cPlan.addEventListener('change', () => { cMonto.value = precioDe().toFixed(2); });
    const cobro = el('section', { class: 'bloque' },
      el('h3', { text: 'Anotar un cobro y renovar' }),
      el('p', { class: 'suave', text: 'Para cuando te pagan en efectivo o por transferencia. El dinero se suma a tus ventas y se renueva el acceso.' }),
      el('label', { for: 'cPlan', text: 'Plan que compró' }), cPlan,
      el('div', { class: 'dos' },
        el('div', {}, el('label', { for: 'cMonto', text: 'Cuánto pagó (US$)' }), cMonto),
        el('div', {}, el('label', { for: 'cDias', text: 'Días de acceso' }), cDias)),
      el('label', { for: 'cMetodo', text: 'Cómo pagó' }), cMetodo,
      el('p', { style: 'margin-top:14px' }, boton('Anotar cobro y renovar', b => ejecutar('registrar_cobro', { plan: cPlan.value, dias: Number(cDias.value), monto: Number(cMonto.value), metodo: cMetodo.value }, b), 'btn')));

    // --- Datos de la cuenta ---
    const inEmail = el('input', { type: 'email', id: 'fEmail', value: u.email, autocomplete: 'off' });
    const inClave = el('input', { type: 'text', id: 'fClave', placeholder: 'Mínimo 6 caracteres', autocomplete: 'off' });
    const cuenta = el('details', { class: 'bloque', open: abiertos.cuenta || undefined, ontoggle: e => { abiertos.cuenta = e.currentTarget.open; } },
      el('summary', { text: 'Datos de la cuenta' }),
      el('label', { for: 'fEmail', text: 'Correo' }),
      el('div', { class: 'campo-fila' }, inEmail, boton('Guardar correo', b => ejecutar('cambiar_email', inEmail.value, b))),
      el('label', { for: 'fClave', text: 'Contraseña nueva' }),
      el('div', { class: 'campo-fila' }, inClave, boton('Generar', () => { inClave.value = generarClave(); inClave.focus(); })),
      el('p', { style: 'margin-top:10px' }, el('div', { class: 'botones-fila' },
        boton('Cambiar contraseña', async b => { const r = await ejecutar('cambiar_clave', inClave.value, b); if (r) { copiar(inClave.value); } }),
        boton('Copiar', () => { if (inClave.value) copiar(inClave.value); }))),
      el('p', { class: 'suave', style: 'margin-top:14px', text: `Ha procesado ${plural(u.usoTotal, 'video', 'videos')} en total.` }),
      boton('Reiniciar el conteo de videos', b => ejecutar('reiniciar_uso', null, b)));

    // --- Zona delicada ---
    const delicada = el('details', { class: 'bloque', open: abiertos.delicada || undefined, ontoggle: e => { abiertos.delicada = e.currentTarget.open; } },
      el('summary', { text: 'Zona delicada' }),
      el('p', { class: 'suave', style: 'margin-top:12px', text: u.activo ? 'Bloquear impide que entre, pero no borra nada. Puedes desbloquearla cuando quieras.' : 'Esta cuenta está bloqueada y no puede entrar.' }),
      el('div', { class: 'botones-fila' },
        u.activo ? boton('Bloquear cuenta', b => ejecutar('bloquear', null, b)) : boton('Desbloquear cuenta', b => ejecutar('desbloquear', null, b), 'btn peq'),
        boton('Eliminar cuenta', async b => {
          const si = await confirmar({ titulo: '¿Eliminar esta cuenta?', texto: `Se borra la cuenta de ${u.email}. Sus pagos se conservan en tus ventas. Esto no se puede deshacer.`, boton: 'Sí, eliminar' });
          if (!si) return;
          const r = await intentar(b, () => api(`/api/admin/usuarios/${u.id}`, { method: 'DELETE' }));
          if (r) { dlg.close(); toast('Cuenta eliminada'); est.resumen = null; ir(est.pagina); }
        }, 'btn peligro peq')));

    dlg.replaceChildren(el('div', { class: 'ficha-interior' },
      el('div', { class: 'ficha-cab' },
        el('h2', { id: 'fichaTitulo', text: u.email }),
        el('button', { type: 'button', class: 'cerrar', 'aria-label': 'Cerrar', text: '✕', onclick: () => dlg.close() })),
      el('div', { class: 'ficha-pills' }, pillEstado(u.estado), pillPlan(u.plan)),
      el('small', { text: `Cliente desde el ${fecha(u.creado)}` }),
      el('div', { class: 'ficha-datos' },
        el('div', {}, el('b', { text: fecha(u.vence) }), el('span', { text: u.estado === 'bloqueado' ? 'Vencimiento (bloqueada)' : `Vence ${enDias(u.diasRestantes)}` })),
        el('div', {}, el('b', { text: `${usado} de ${plan.videosPorMes}` }), el('span', { text: esPrueba ? 'Videos de la prueba' : 'Videos este mes' })),
        el('div', {}, el('b', { text: u.usoTotal }), el('span', { text: 'Videos en total' }))),
      tiempo, bloquePlan, cobro, cuenta, delicada));
  }
  pintar();
  dlg.showModal();
}

// ---------------------- Crear un usuario ----------------------
function abrirNuevo() {
  const dlg = $('dlgNuevo');
  const pagos = Object.entries(est.planes).filter(([, p]) => !p.esPrueba);
  const inEmail = el('input', { type: 'email', id: 'nEmail', required: true, autocomplete: 'off', placeholder: 'cliente@correo.com' });
  const inClave = el('input', { type: 'text', id: 'nClave', required: true, minlength: 6, autocomplete: 'off', value: generarClave() });
  const selPlan = el('select', { id: 'nPlan' }, Object.entries(est.planes).map(([id, p]) => el('option', { value: id, text: p.nombre, selected: id === (pagos[pagos.length - 1] || [])[0] || undefined })));
  const inDias = el('input', { type: 'number', id: 'nDias', min: 1, max: 3650, value: est.diasPorCompra || 30, required: true });
  const inMonto = el('input', { type: 'number', id: 'nMonto', min: 0, step: '0.01', placeholder: 'Si no te pagó, déjalo vacío', inputmode: 'decimal' });
  const selMetodo = el('select', { id: 'nMetodo' }, ['efectivo', 'transferencia', 'otro'].map(m => el('option', { value: m, text: METODOS[m] })));
  const error = el('p', { class: 'error', role: 'alert' });

  const forma = el('form', { class: 'modal-interior' },
    el('h2', { id: 'nuevoTitulo', text: 'Nuevo usuario' }),
    el('p', { class: 'suave', style: 'margin-top:6px', text: 'Úsalo para regalar acceso o cuando alguien te paga fuera de la web. Si el correo ya existe, se renueva con esta contraseña.' }),
    el('label', { for: 'nEmail', text: 'Correo' }), inEmail,
    el('label', { for: 'nClave', text: 'Contraseña' }),
    el('div', { class: 'campo-fila' }, inClave, boton2('Generar otra', () => { inClave.value = generarClave(); })),
    el('div', { class: 'dos' },
      el('div', {}, el('label', { for: 'nPlan', text: 'Plan' }), selPlan),
      el('div', {}, el('label', { for: 'nDias', text: 'Días de acceso' }), inDias)),
    el('div', { class: 'dos' },
      el('div', {}, el('label', { for: 'nMonto', text: 'Cuánto pagó (US$)' }), inMonto),
      el('div', {}, el('label', { for: 'nMetodo', text: 'Cómo pagó' }), selMetodo)),
    error,
    el('div', { class: 'modal-acciones' },
      el('button', { type: 'button', class: 'btn sec', text: 'Cancelar', onclick: () => dlg.close() }),
      el('button', { type: 'submit', class: 'btn', text: 'Crear usuario' })));

  forma.addEventListener('submit', async e => {
    e.preventDefault();
    error.textContent = '';
    const enviar = forma.querySelector('button[type=submit]');
    enviar.disabled = true;
    try {
      const cuerpo = { email: inEmail.value, password: inClave.value, plan: selPlan.value, dias: Number(inDias.value) };
      if (inMonto.value !== '' && Number(inMonto.value) > 0) { cuerpo.monto = Number(inMonto.value); cuerpo.metodo = selMetodo.value; }
      const r = await api('/api/admin/usuario', { method: 'POST', cuerpo });
      est.resumen = null;
      if (est.recargarUsuarios) est.recargarUsuarios();
      const mensaje = `Hola. Ya tienes acceso a VideoClips.\nEntra aquí: ${location.origin}\nCorreo: ${r.email}\nContraseña: ${inClave.value}\nTu acceso vence el ${fecha(r.vence)}.`;
      dlg.replaceChildren(el('div', { class: 'modal-interior' },
        el('h2', { id: 'nuevoTitulo', text: r.creado ? 'Usuario creado' : 'Usuario renovado' }),
        el('p', { class: 'suave', style: 'margin-top:6px', text: r.cobro ? `Se anotó un cobro de ${usd(r.cobro)}. Copia este mensaje y envíaselo a tu cliente:` : 'Copia este mensaje y envíaselo a tu cliente:' }),
        el('div', { class: 'copiable', text: mensaje }),
        el('div', { class: 'modal-acciones' },
          el('button', { type: 'button', class: 'btn sec', text: 'Cerrar', onclick: () => dlg.close() }),
          el('button', { type: 'button', class: 'btn', text: 'Copiar mensaje', onclick: () => copiar(mensaje) }))));
    } catch (err) { if (err.message !== 'sesion') error.textContent = err.message; }
    enviar.disabled = false;
  });
  dlg.replaceChildren(forma);
  dlg.showModal();
  inEmail.focus();
}
const boton2 = (texto, fn) => el('button', { type: 'button', class: 'btn sec peq', text: texto, onclick: fn });

// ======================================================================
//  VENTAS
// ======================================================================
async function paginaVentas(cont, vigente) {
  titulo('Ventas', 'El dinero que entra cada vez que alguien compra un plan. Los montos están en dólares.');
  const [r, p] = await Promise.all([api('/api/admin/resumen'), api('/api/admin/pagos')]);
  if (!vigente()) return;
  est.resumen = r; ponerPuntoSistema(r.porConfigurar);
  const pagos = p.pagos;
  const v = r.ingresos;
  const mesPasado = r.mensual.length > 1 ? r.mensual[r.mensual.length - 2].ingresos : 0;
  const promedio = v.cantidad ? v.total / v.cantidad : 0;

  $('accionesPag').replaceChildren(el('button', { type: 'button', class: 'btn sec', text: 'Descargar para Excel', disabled: !pagos.length, onclick: () => descargarCsv(pagos) }));

  let filtro = 'todas';
  const chips = el('div', { class: 'filtros', role: 'group', 'aria-label': 'Filtrar ventas' });
  const caja = el('div', {});
  const pintarChips = () => chips.replaceChildren(...[['todas', 'Todas'], ['pagado', 'Cobradas'], ['pendiente', 'Sin terminar']].map(([k, txt]) => el('button', {
    type: 'button', 'aria-pressed': String(filtro === k), onclick: () => { filtro = k; pintarChips(); pintarTabla(); },
  }, txt, el('span', { text: k === 'todas' ? pagos.length : pagos.filter(x => x.estado === k).length }))));

  function pintarTabla() {
    const lista = pagos.filter(x => filtro === 'todas' || x.estado === filtro);
    if (!lista.length) {
      caja.replaceChildren(el('div', { class: 'tabla-caja vacio' },
        el('h3', { text: pagos.length ? 'No hay ventas con ese filtro' : 'Todavía no hay ventas' }),
        el('p', { text: pagos.length ? 'Prueba con otro filtro.' : 'Cuando alguien compre un plan, aparecerá aquí con su monto. Si te pagan en efectivo o transferencia, anótalo desde la ficha del usuario.' })));
      return;
    }
    caja.replaceChildren(el('div', { class: 'tabla-caja' },
      el('table', { class: 'tabla' },
        el('thead', {}, el('tr', {}, [['Fecha', ''], ['Cliente', ''], ['Plan', ''], ['Cómo pagó', ''], ['Estado', ''], ['Monto', 'num']].map(([t, c]) => el('th', { scope: 'col', class: c, text: t })))),
        el('tbody', {}, lista.map(x => {
          const ok = x.estado === 'pagado', cuando = ok && x.pagadoEn ? x.pagadoEn : x.creado;
          return el('tr', {},
            el('td', { 'data-etiqueta': 'Fecha' }, el('b', { text: fecha(cuando) }), el('div', {}, el('small', { text: parseUtc(cuando).toLocaleTimeString('es', { hour: 'numeric', minute: '2-digit' }) }))),
            el('td', { 'data-etiqueta': 'Cliente' }, el('span', { class: 'persona' }, el('b', { text: x.email }))),
            el('td', { 'data-etiqueta': 'Plan' }, pillPlan(x.plan)),
            el('td', { 'data-etiqueta': 'Cómo pagó', text: METODOS[x.proveedor] || x.proveedor }),
            el('td', { 'data-etiqueta': 'Estado' }, el('span', { class: 'pill ' + (ok ? 'ok' : 'pendiente'), text: ok ? 'Cobrada' : 'Sin terminar' })),
            el('td', { class: 'num', 'data-etiqueta': 'Monto', text: ok ? usd(x.monto) : '(' + usd(x.monto) + ')' }));
        }))),
      el('div', { class: 'pie-tabla' }, el('small', { text: 'Se muestran las últimas 100. "Sin terminar" es alguien que empezó a pagar pero no completó el pago: no cuenta como dinero cobrado.' }))));
  }
  pintarChips(); pintarTabla();

  cont.replaceChildren(
    el('div', { class: 'rejilla datos' },
      el('div', { class: 'dato dinero' }, el('span', { text: 'Cobrado este mes' }), el('b', { text: usd(v.mes) }), el('small', { text: plural(v.pagosMes, 'venta', 'ventas') })),
      el('div', { class: 'dato' }, el('span', { text: 'Mes pasado' }), el('b', { text: usd(mesPasado) })),
      el('div', { class: 'dato dinero' }, el('span', { text: 'Total guardado hasta hoy' }), el('b', { text: usd(v.total) }), el('small', { text: plural(v.cantidad, 'venta cobrada', 'ventas cobradas') })),
      el('div', { class: 'dato' }, el('span', { text: 'Venta promedio' }), el('b', { text: usd(promedio) }))),
    el('div', { class: 'rejilla' }, tarjetaGrafica('Dinero cobrado por mes', 'Los últimos 6 meses. El borde marca el mes actual.',
      barras({ datos: r.mensual, clave: 'ingresos', formato: usd0, dinero: true, vacio: 'Aquí verás cuánto dinero entra cada mes.' }))),
    el('div', { class: 'barra-herramientas' }, chips), caja);
}

// Descarga las ventas como archivo que abre Excel
function descargarCsv(pagos) {
  const celda = t => `"${String(t).replace(/"/g, '""')}"`;
  const filas = [['Fecha', 'Cliente', 'Plan', 'Cómo pagó', 'Estado', 'Monto US$']].concat(pagos.map(x => [
    (x.pagadoEn || x.creado).slice(0, 10), x.email, nombrePlan(x.plan), METODOS[x.proveedor] || x.proveedor, x.estado === 'pagado' ? 'Cobrada' : 'Sin terminar', Number(x.monto).toFixed(2)]));
  const blob = new Blob(['﻿' + filas.map(f => f.map(celda).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `ventas-videoclips-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a); a.click(); a.remove();
}

// ======================================================================
//  PLANES Y PRECIOS
// ======================================================================
async function paginaPlanes(cont, vigente) {
  titulo('Planes y precios', 'Cambia lo que cuesta cada plan y lo que incluye. Se aplica al momento, sin tocar el código.');
  const d = await api('/api/admin/planes');
  if (!vigente()) return;
  est.planes = d.planes; est.prueba = d.prueba; est.maximos = d.maximos;
  const pagos = Object.entries(d.planes).filter(([, p]) => !p.esPrueba);
  const prueba = d.planes.prueba;
  cont.replaceChildren(
    el('div', { class: 'rejilla mitad' }, pagos.map(([id, p]) => formaPlan(id, p, d))),
    ...(prueba ? [formaPrueba(prueba, d)] : []),
    el('p', { class: 'nota', text: `Cada compra da ${d.diasPorCompra} días de acceso. Cambiar un precio solo afecta las compras nuevas; los límites (videos, clips, segundos) cambian al instante para todos los que tienen ese plan.` }));
}

// Un campo numérico con su etiqueta
function campoNum(id, etiqueta, valor, { min, max, paso = 1, sufijo, ayuda } = {}) {
  const input = el('input', { type: 'number', id, value: valor, min, max, step: paso, inputmode: paso < 1 ? 'decimal' : 'numeric' });
  return { input, nodo: el('div', {}, el('label', { for: id, text: etiqueta }), sufijo ? el('div', { class: 'sufijo' }, input, el('em', { text: sufijo })) : input, ayuda ? el('small', { text: ayuda }) : null) };
}
function interruptor(id, texto, marcado) {
  const input = el('input', { type: 'checkbox', id, checked: marcado || undefined });
  return { input, nodo: el('label', { class: 'interruptor', for: id }, input, texto) };
}

function formaPlan(id, p, d) {
  const nombre = el('input', { type: 'text', id: `n-${id}`, value: p.nombre, maxlength: 30 });
  const precio = campoNum(`p-${id}`, 'Precio de cada compra (US$)', p.precioUSD, { min: 0.5, max: 10000, paso: 0.01, sufijo: 'US$' });
  const videos = campoNum(`v-${id}`, 'Videos por mes', p.videosPorMes, { min: 1, max: 100000 });
  const clips = campoNum(`c-${id}`, 'Clips por video', p.maxClips, { min: 1, max: d.maximos.clips, ayuda: `Máximo ${d.maximos.clips}` });
  const seg = campoNum(`s-${id}`, 'Segundos por clip', p.maxDuracion, { min: 3, max: d.maximos.duracion, ayuda: `Máximo ${d.maximos.duracion}` });
  const logo = interruptor(`l-${id}`, 'Puede poner su logo en los clips', p.logo);
  const pub = interruptor(`b-${id}`, 'Puede publicar directo en redes', p.publicar);
  const guardar = el('button', { type: 'button', class: 'btn', text: 'Guardar cambios', disabled: true });
  const leer = () => ({ nombre: nombre.value.trim(), precioUSD: Number(precio.input.value), videosPorMes: Number(videos.input.value), maxClips: Number(clips.input.value), maxDuracion: Number(seg.input.value), logo: logo.input.checked, publicar: pub.input.checked });
  let base = JSON.stringify(leer());
  const revisar = () => { guardar.disabled = JSON.stringify(leer()) === base; };
  guardar.onclick = async () => {
    const r = await intentar(guardar, () => api(`/api/admin/planes/${id}`, { method: 'PUT', cuerpo: leer() }));
    if (r) { est.planes[id] = r.plan; base = JSON.stringify(leer()); toast(`Plan ${r.plan.nombre} guardado`); }
    revisar();
  };
  const forma = el('section', { class: 'tarjeta plan-forma' },
    el('h2', {}, el('span', { text: p.nombre }), pillPlan(id)),
    el('label', { for: `n-${id}`, text: 'Nombre del plan' }), nombre,
    el('div', { class: 'dos' }, precio.nodo, videos.nodo),
    el('div', { class: 'dos' }, clips.nodo, seg.nodo),
    logo.nodo, pub.nodo,
    el('div', { class: 'acciones' }, el('small', { text: `Precio actual: ${usd(p.precioUSD)}` }), guardar));
  forma.addEventListener('input', revisar); forma.addEventListener('change', revisar);
  return forma;
}

function formaPrueba(p, d) {
  const activa = interruptor('pr-activa', 'La prueba gratis está activa (se muestra en la web)', d.prueba.activa);
  const dias = campoNum('pr-dias', 'Días de prueba', d.prueba.dias, { min: 1, max: 90 });
  const videos = campoNum('pr-videos', 'Videos en total', p.videosPorMes, { min: 1, max: 100000, ayuda: 'En la prueba cuentan en total, no por mes.' });
  const clips = campoNum('pr-clips', 'Clips por video', p.maxClips, { min: 1, max: d.maximos.clips });
  const seg = campoNum('pr-seg', 'Segundos por clip', p.maxDuracion, { min: 3, max: d.maximos.duracion });
  const guardar = el('button', { type: 'button', class: 'btn', text: 'Guardar cambios', disabled: true });
  const leer = () => ({ activa: activa.input.checked, dias: Number(dias.input.value), videosPorMes: Number(videos.input.value), maxClips: Number(clips.input.value), maxDuracion: Number(seg.input.value) });
  let base = JSON.stringify(leer());
  const revisar = () => { guardar.disabled = JSON.stringify(leer()) === base; };
  guardar.onclick = async () => {
    const v = leer();
    const r = await intentar(guardar, async () => {
      await api('/api/admin/planes/prueba', { method: 'PUT', cuerpo: { videosPorMes: v.videosPorMes, maxClips: v.maxClips, maxDuracion: v.maxDuracion } });
      return api('/api/admin/prueba', { method: 'PUT', cuerpo: { activa: v.activa, dias: v.dias } });
    });
    if (r) { base = JSON.stringify(leer()); toast('Prueba gratis guardada'); }
    revisar();
  };
  const forma = el('section', { class: 'tarjeta plan-forma', style: 'margin-bottom:20px' },
    el('h2', {}, el('span', { text: 'Prueba gratis' }), el('span', { class: 'pill prueba', text: 'Sin tarjeta' })),
    el('p', { class: 'suave', text: 'Lo que recibe una persona nueva al registrarse sin pagar. Solo puede usarla una vez por correo.' }),
    activa.nodo,
    el('div', { class: 'dos' }, dias.nodo, videos.nodo),
    el('div', { class: 'dos' }, clips.nodo, seg.nodo),
    el('div', { class: 'acciones' }, el('small', { text: 'Se activa al registrarse en la pestaña "Prueba gratis".' }), guardar));
  forma.addEventListener('input', revisar); forma.addEventListener('change', revisar);
  return forma;
}

// ======================================================================
//  ESTADO DEL SISTEMA
// ======================================================================
async function paginaSistema(cont, vigente) {
  titulo('Estado del sistema', 'Una revisión rápida para saber si todo está bien configurado.');
  const d = await api('/api/admin/sistema');
  if (!vigente()) return;
  const orden = { falta: 0, aviso: 1, ok: 2, opcional: 3 };
  const falta = d.puntos.filter(p => p.estado === 'falta').length;
  ponerPuntoSistema(falta);
  const iconos = { ok: '✓', aviso: '!', falta: '✕', opcional: '–' };
  const s = d.servidor;
  const horas = Math.floor(s.encendidoHace / 3600), min = Math.floor((s.encendidoHace % 3600) / 60);
  cont.replaceChildren(
    el('div', { class: 'rejilla datos' },
      el('div', { class: 'dato' }, el('span', { text: 'Videos procesándose' }), el('b', { text: s.activos }), el('small', { text: plural(s.esperando, 'esperando en la fila', 'esperando en la fila') })),
      el('div', { class: 'dato' }, el('span', { text: 'Clips guardados ahora' }), el('b', { text: s.trabajos }), el('small', { text: 'Se borran solos a los 20 minutos' })),
      el('div', { class: 'dato' }, el('span', { text: 'Encendido hace' }), el('b', { text: horas ? `${horas} h ${min} min` : `${min} min` })),
      el('div', { class: 'dato' }, el('span', { text: 'Memoria en uso' }), el('b', { text: `${s.memoriaMB} MB` }), el('small', { text: `Node ${s.node}` }))),
    el('div', { class: 'revision' }, d.puntos.slice().sort((a, b) => orden[a.estado] - orden[b.estado]).map(p =>
      el('div', { class: 'revision-fila ' + p.estado },
        el('span', { class: 'icono', 'aria-hidden': 'true', text: iconos[p.estado] }),
        el('div', {}, el('b', { text: p.titulo }), el('p', { text: p.detalle }))))));
}

// ======================================================================
//  ARRANQUE
// ======================================================================
(async function iniciar() {
  try { await api('/api/admin/sesion'); await abrirPanel(); }
  catch (e) { if (e.message !== 'sesion') mostrarLogin(); }
})();
