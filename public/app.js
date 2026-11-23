// =====================================================================
// VIDEOCLIPS - lógica de la página (lo que pasa cuando tocas los botones)
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

// Llamada al servidor: devuelve { ok, status, datos }
async function api(url, opciones) {
  const r = await fetch(url, opciones);
  let datos = {};
  try { datos = await r.json(); } catch { /* sin cuerpo */ }
  return { ok: r.ok, status: r.status, datos };
}

const formatoTiempo = s => { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const precio = n => '$' + n.toFixed(2);

// Memoria del navegador (recuerda tu última configuración). Puede fallar en modo privado.
const memoria = {
  leer() { try { return JSON.parse(localStorage.getItem('vc_prefs') || '{}'); } catch { return {}; } },
  guardar(o) { try { localStorage.setItem('vc_prefs', JSON.stringify(o)); } catch { /* nada */ } },
};

const est = {
  yo: null,            // datos de la cuenta
  planes: null,        // planes a la venta
  redes: [],           // redes disponibles en el servidor
  entrada: 'link',     // 'link' o 'archivo'
  trabajo: null,       // id del trabajo en marcha
  finEn: null,         // cuándo se borran los clips
  planSel: null,
  pubClip: null,
  temporizador: null,
};

// ---------------------- Mensajes ----------------------
let relojAviso = null;
function avisar(texto, tipo = 'info') {
  const a = $('aviso');
  a.textContent = texto; a.className = 'banner ' + tipo;
  clearTimeout(relojAviso);
  relojAviso = setTimeout(() => a.classList.add('oculto'), 9000);
}

function mostrar(vista) {
  $('vistaAcceso').classList.toggle('oculto', vista !== 'acceso');
  $('vistaApp').classList.toggle('oculto', vista !== 'app');
}

// ---------------------- Arranque ----------------------
async function iniciar() {
  const r = await api('/api/yo');
  if (r.ok) {
    est.yo = r.datos;
    prepararApp();
    mostrar('app');
    cargarRedes();
  } else {
    if (r.datos.vencido) avisar('Tu acceso venció. Renueva tu plan para seguir.', 'error');
    await prepararAcceso();
    mostrar('acceso');
    if (r.datos.vencido) cambiarTabAcceso('comprar');
  }
}

// ======================================================================
//  ACCESO: entrar y comprar
// ======================================================================
function cambiarTabAcceso(cual) {
  $('tabEntrar').classList.toggle('on', cual === 'entrar');
  $('tabPrueba').classList.toggle('on', cual === 'prueba');
  $('tabComprar').classList.toggle('on', cual === 'comprar');
  $('formEntrar').classList.toggle('oculto', cual !== 'entrar');
  $('formPrueba').classList.toggle('oculto', cual !== 'prueba');
  $('formComprar').classList.toggle('oculto', cual !== 'comprar');
}
$('tabEntrar').onclick = () => cambiarTabAcceso('entrar');
$('tabPrueba').onclick = () => cambiarTabAcceso('prueba');
$('tabComprar').onclick = () => cambiarTabAcceso('comprar');

// Prueba gratis: crea la cuenta sin pagar y entra directo
$('formPrueba').addEventListener('submit', async e => {
  e.preventDefault();
  $('btnPrueba').disabled = true; $('errPrueba').textContent = '';
  const r = await api('/api/registro', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: $('emailPrueba').value, password: $('clavePrueba').value }),
  });
  $('btnPrueba').disabled = false;
  if (r.ok) { avisar('¡Listo! Tu prueba gratis empezó. Crea tus primeros clips.', 'ok'); iniciar(); }
  else $('errPrueba').textContent = r.datos.error || 'No se pudo crear la prueba';
});

$('formEntrar').addEventListener('submit', async e => {
  e.preventDefault();
  $('btnEntrar').disabled = true; $('errLogin').textContent = '';
  const r = await api('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: $('email').value, password: $('clave').value }),
  });
  $('btnEntrar').disabled = false;
  if (r.ok) iniciar(); else $('errLogin').textContent = r.datos.error || 'No se pudo entrar';
});

$('btnSalir').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };

async function prepararAcceso() {
  if (!est.planes) {
    const r = await api('/api/planes');
    est.planes = r.ok ? r.datos : { planes: [], proveedores: [], dias: 30 };
  }
  const { planes, proveedores, dias, prueba } = est.planes;

  // Prueba gratis (solo si el administrador la tiene activa)
  $('tabPrueba').classList.toggle('oculto', !prueba);
  if (prueba) {
    $('tituloPrueba').textContent = `${prueba.dias} días gratis, sin tarjeta`;
    $('listaPrueba').replaceChildren(...[
      `${prueba.videosPorMes} videos para probar`,
      `Hasta ${prueba.maxClips} clips por video`,
      `Clips de hasta ${prueba.maxDuracion} segundos`,
    ].map(t => el('li', { text: t })));
  }
  const cont = $('listaPlanes');
  cont.replaceChildren();
  planes.forEach((p, i) => {
    const puntos = [
      `${p.videosPorMes} videos por mes`,
      `Hasta ${p.maxClips} clips por video`,
      `Clips de hasta ${p.maxDuracion} segundos`,
      p.logo ? '✓ Tu logo en los clips' : '✗ Sin logo',
      p.publicar ? '✓ Publicar directo en redes' : '✗ Sin publicar directo',
    ];
    cont.append(el('label', { class: 'plan-op' },
      el('input', { type: 'radio', name: 'plan', value: p.id, checked: i === planes.length - 1 || undefined,
        onchange: () => { est.planSel = p.id; } }),
      el('span', { class: 'precio', text: precio(p.precioUSD) }),
      el('b', { text: p.nombre }), el('br'),
      el('small', { text: `por ${dias} días de acceso` }),
      el('ul', {}, puntos.map(t => el('li', { text: t }))),
    ));
    if (i === planes.length - 1) est.planSel = p.id;
  });

  const m = $('metodosPago');
  m.replaceChildren();
  if (!proveedores.length) {
    m.append(el('small', { text: 'Las compras en línea todavía no están activadas. Contacta al administrador para obtener tu acceso.' }));
  }
  const etiquetas = { stripe: '💳 Pagar con tarjeta', paypal: 'Pagar con PayPal' };
  proveedores.forEach(pr => m.append(el('button', { type: 'button', class: 'grande', text: etiquetas[pr] || pr, onclick: () => pagar(pr) })));
}

async function pagar(proveedor) {
  $('errCompra').textContent = '';
  const email = $('emailCompra').value.trim(), password = $('claveCompra').value;
  if (!email || password.length < 6) { $('errCompra').textContent = 'Escribe tu correo y una contraseña de al menos 6 caracteres.'; return; }
  const botones = $('metodosPago').querySelectorAll('button');
  botones.forEach(b => (b.disabled = true));
  const r = await api('/api/pago/crear', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, plan: est.planSel, proveedor }),
  });
  if (r.ok && r.datos.url) { location.href = r.datos.url; return; }
  botones.forEach(b => (b.disabled = false));
  $('errCompra').textContent = r.datos.error || 'No se pudo iniciar el pago';
}

// Desde la app: "Mejorar / renovar"
$('btnMejorar').onclick = async () => {
  await prepararAcceso();
  $('emailCompra').value = est.yo.email;
  $('claveCompra').value = '';
  $('btnVolver').classList.remove('oculto');
  cambiarTabAcceso('comprar');
  $('tabEntrar').classList.add('oculto');
  $('tabPrueba').classList.add('oculto');          // quien ya tiene cuenta no vuelve a la prueba
  mostrar('acceso');
};
$('btnVolver').onclick = () => { $('tabEntrar').classList.remove('oculto'); $('btnVolver').classList.add('oculto'); mostrar('app'); };
$('btnComprarDesdePrueba').onclick = () => $('btnMejorar').click();

// ======================================================================
//  APP: preparar pantalla según el plan
// ======================================================================
// Días que le quedan hasta la fecha de vencimiento (AAAA-MM-DD)
function diasRestantes(vence) {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((new Date(vence + 'T00:00:00') - hoy) / 86400000));
}

// Pinta el plan, el contador de videos y el aviso de la prueba gratis
function pintarPlan() {
  const { vence, plan, usoMes } = est.yo;
  const prueba = !!plan.esPrueba;
  $('planNombre').textContent = prueba ? 'Prueba gratis' : `Plan ${plan.nombre}`;
  $('planDetalle').textContent = prueba
    ? `${usoMes} de ${plan.videosPorMes} videos usados`
    : `Acceso hasta ${vence} · ${usoMes} de ${plan.videosPorMes} videos este mes`;
  $('usoBarra').style.width = Math.min(100, (usoMes / plan.videosPorMes) * 100) + '%';
  $('btnMejorar').textContent = prueba ? 'Comprar un plan' : 'Mejorar o renovar';

  const banner = $('bannerPrueba');
  banner.classList.toggle('oculto', !prueba);
  if (prueba) {
    const d = diasRestantes(vence), quedan = Math.max(0, plan.videosPorMes - usoMes);
    $('bannerTitulo').textContent = d === 1 ? 'Te queda 1 día de prueba' : `Te quedan ${d} días de prueba`;
    $('bannerTexto').textContent = quedan > 0
      ? `Puedes crear ${quedan} ${quedan === 1 ? 'video más' : 'videos más'}. Con un plan tienes más videos, clips más largos y puedes poner tu logo.`
      : 'Ya usaste todos los videos de tu prueba. Compra un plan para seguir creando clips.';
  }
}

function prepararApp() {
  const { email, plan, limites } = est.yo;
  $('infoUsuario').textContent = email;
  pintarPlan();

  // Límites de los botones + y −
  $('cantidad').max = limites.maxClips;
  $('duracion').max = limites.maxDuracion;
  construirChips('chipsCantidad', 'cantidad', [1, 3, 5, 8, 10, 15, 20].filter(v => v <= limites.maxClips), v => v);
  construirChips('chipsDuracion', 'duracion', [15, 30, 45, 60, 90, 120, 180].filter(v => v <= limites.maxDuracion), v => v + ' s');

  // Logo: solo planes que lo incluyen
  $('bloqueLogo').classList.toggle('bloqueado', !plan.logo);
  $('etiquetaPro').classList.toggle('oculto', plan.logo);
  $('logo').disabled = !plan.logo;

  // Recordar la última configuración
  const p = memoria.leer();
  if (p.cantidad) $('cantidad').value = p.cantidad;
  if (p.duracion) $('duracion').value = p.duracion;
  if (p.modo) { const r = document.querySelector(`input[name=modo][value=${p.modo}]`); if (r) r.checked = true; }
  if (p.formato) { const r = document.querySelector(`input[name=formato][value=${p.formato}]`); if (r) r.checked = true; }
  ajustarValores(); alCambiar();
}

function ajustarValores() {
  for (const id of ['cantidad', 'duracion']) {
    const i = $(id), min = Number(i.min), max = Number(i.max);
    let v = Math.floor(Number(i.value));
    if (!v || v < min) v = min;
    if (v > max) v = max;
    i.value = v;
  }
}

// Atajos rápidos (3, 5, 10... / 15 s, 30 s...)
function construirChips(idContenedor, idInput, valores, texto) {
  const c = $(idContenedor);
  c.replaceChildren(...valores.map(v => el('button', {
    type: 'button', 'data-v': v, text: texto(v),
    onclick: () => { $(idInput).value = v; alCambiar(); },
  })));
}

// Botones + y −. Si los mantienes presionados, siguen sumando o restando.
function montarStepper(idContenedor, paso) {
  const cont = $(idContenedor), input = cont.querySelector('input');
  const mover = dir => {
    const min = Number(input.min), max = Number(input.max);
    const cur = Math.floor(Number(input.value)) || min;
    let v;
    if (paso > 1) v = dir > 0 ? Math.floor(cur / paso) * paso + paso : Math.ceil(cur / paso) * paso - paso;
    else v = cur + dir;
    input.value = Math.min(max, Math.max(min, v));
    alCambiar();
  };
  cont.querySelectorAll('button').forEach(b => {
    const dir = Number(b.dataset.dir);
    let espera = null, repite = null;
    const parar = () => { clearTimeout(espera); clearInterval(repite); };
    b.addEventListener('pointerdown', () => {
      if (input.disabled) return;
      mover(dir);
      espera = setTimeout(() => { repite = setInterval(() => mover(dir), 90); }, 450);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, parar));
    b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); mover(dir); } });
  });
  input.addEventListener('input', alCambiar);
  input.addEventListener('change', () => { ajustarValores(); alCambiar(); });
}
montarStepper('stCantidad', 1);
montarStepper('stDuracion', 5);

const valorRadio = nombre => (document.querySelector(`input[name=${nombre}]:checked`) || {}).value;

// Se llama cada vez que cambias algo: actualiza atajos, resumen y guarda tus preferencias
function alCambiar() {
  const cantidad = Math.floor(Number($('cantidad').value)) || 0;
  const duracion = Math.floor(Number($('duracion').value)) || 0;
  const modo = valorRadio('modo');

  document.querySelectorAll('#chipsCantidad button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === cantidad));
  document.querySelectorAll('#chipsDuracion button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === duracion));

  const iguales = modo === 'iguales';
  $('controlDuracion').classList.toggle('apagado', iguales);
  $('duracion').disabled = iguales;
  $('notaDuracion').classList.toggle('oculto', !iguales);

  if (iguales) $('resumen').textContent = `Tu video se dividirá en ${cantidad} partes iguales, una detrás de otra.`;
  else $('resumen').textContent = `${cantidad} ${cantidad === 1 ? 'clip' : 'clips'} × ${duracion} s = ${formatoTiempo(cantidad * duracion)} de contenido en total`;

  memoria.guardar({ cantidad, duracion, modo, formato: valorRadio('formato') });
}
document.querySelectorAll('input[name=modo], input[name=formato]').forEach(i => i.addEventListener('change', alCambiar));

// ---------- Video: link o archivo ----------
function cambiarEntrada(m) {
  est.entrada = m;
  $('tabLink').classList.toggle('on', m === 'link');
  $('tabArchivo').classList.toggle('on', m === 'archivo');
  $('bloqueLink').classList.toggle('oculto', m !== 'link');
  $('bloqueArchivo').classList.toggle('oculto', m !== 'archivo');
}
$('tabLink').onclick = () => cambiarEntrada('link');
$('tabArchivo').onclick = () => cambiarEntrada('archivo');

// ---------- Logo ----------
$('logo').addEventListener('change', () => {
  const f = $('logo').files[0];
  if (!f) return $('opcionesLogo').classList.add('oculto');
  if (f.size > 1024 * 1024) { avisar('El logo pesa demasiado (máximo 1 MB).', 'error'); $('logo').value = ''; return; }
  $('vistaLogo').src = URL.createObjectURL(f);
  $('opcionesLogo').classList.remove('oculto');
});
$('btnQuitarLogo').onclick = () => { $('logo').value = ''; $('opcionesLogo').classList.add('oculto'); };

// ======================================================================
//  CREAR CLIPS
// ======================================================================
$('btnProcesar').onclick = () => {
  const datos = new FormData();
  datos.append('cantidad', $('cantidad').value);
  datos.append('duracion', $('duracion').value);
  datos.append('modo', valorRadio('modo'));
  datos.append('formato', valorRadio('formato'));
  datos.append('desde', $('desde').value);
  datos.append('hasta', $('hasta').value);
  if (est.entrada === 'link') {
    if (!$('link').value.trim()) return avisar('Pega el link de un video.', 'error');
    datos.append('link', $('link').value);
  } else {
    if (!$('archivo').files[0]) return avisar('Elige un archivo de video.', 'error');
    datos.append('video', $('archivo').files[0]);
  }
  if ($('logo').files[0] && !$('logo').disabled) {
    datos.append('logo', $('logo').files[0]);
    datos.append('logoPosicion', valorRadio('logoPos'));
    datos.append('logoTamano', $('logoTamano').value);
  }

  $('btnProcesar').disabled = true;
  $('resultados').classList.add('oculto');
  $('estado').classList.remove('oculto');
  ponerProgreso('Enviando...', 0, true);
  $('estado').scrollIntoView({ behavior: 'smooth', block: 'center' });

  // XMLHttpRequest para poder mostrar el % mientras se sube el archivo
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/procesar');
  xhr.upload.onprogress = e => {
    if (est.entrada === 'archivo' && e.lengthComputable) {
      const p = Math.round((e.loaded / e.total) * 100);
      ponerProgreso(`Subiendo video... ${p}%`, p / 2, false);
    }
  };
  xhr.onload = () => {
    let r = {}; try { r = JSON.parse(xhr.responseText); } catch { /* nada */ }
    if (xhr.status === 401) return location.reload();
    if (xhr.status !== 200) return fallo(r.error || 'Error al enviar');
    est.trabajo = r.id; consultar();
  };
  xhr.onerror = () => fallo('Error de conexión');
  xhr.send(datos);
};

function ponerProgreso(texto, porcentaje, indeterminada) {
  $('mensaje').className = 'msg'; $('mensaje').textContent = texto;
  $('progreso').style.width = porcentaje + '%';
  document.querySelector('#estado .barra').classList.toggle('indeterminada', !!indeterminada);
}
function fallo(texto) {
  $('btnProcesar').disabled = false;
  $('mensaje').className = 'msg error'; $('mensaje').textContent = texto;
  document.querySelector('#estado .barra').classList.remove('indeterminada');
  $('progreso').style.width = '0';
}

// Preguntamos al servidor cómo va (cada 2 segundos)
let erroresRed = 0;
async function consultar() {
  let r;
  try { r = await api('/api/trabajo/' + est.trabajo); erroresRed = 0; }
  catch { if (++erroresRed > 5) return fallo('Se perdió la conexión. Revisa tu internet y vuelve a intentar.'); return setTimeout(consultar, 3000); }
  if (r.status === 401) return location.reload();
  if (!r.ok) return fallo('El trabajo expiró. Intenta de nuevo.');
  const t = r.datos;
  const base = est.entrada === 'archivo' ? 50 : 0, rango = est.entrada === 'archivo' ? 50 : 100;

  if (t.estado === 'en_cola') {
    ponerProgreso(t.posicion > 0 ? `Estás en la fila (puesto ${t.posicion}). Empieza solo, no cierres la página.` : 'Empezando...', base, true);
    return setTimeout(consultar, 2000);
  }
  if (t.estado === 'procesando') {
    ponerProgreso(t.mensaje, base + (t.progreso * rango) / 100, t.progreso === 0);
    return setTimeout(consultar, 2000);
  }
  $('btnProcesar').disabled = false;
  if (t.estado === 'error') return fallo(t.mensaje);

  ponerProgreso(t.mensaje, 100, false);
  $('mensaje').className = 'msg ok';
  mostrarClips(t);
  const yo = await api('/api/yo');                    // actualiza el contador del mes
  if (yo.ok) { est.yo = yo.datos; prepararPlanBarra(); }
}
function prepararPlanBarra() { pintarPlan(); }

// ---------- Lista de clips ----------
function mostrarClips(t) {
  const cont = $('resultados');
  cont.classList.remove('oculto');
  $('btnZip').href = `/api/zip/${est.trabajo}`;
  $('btnZip').classList.toggle('oculto', t.clips.length < 2);
  est.finEn = Date.now() + (t.expiraEn || 0) * 1000;
  iniciarCuenta();
  est.clips = t.clips;
  pintarLista();
  cont.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Dibuja (o vuelve a dibujar) la lista de clips. Se llama otra vez después de editar un clip.
function pintarLista() {
  const puedePublicar = est.yo.plan.publicar && est.redes.length > 0;
  const lista = $('listaClips');
  lista.replaceChildren();
  est.clips.forEach(c => {
    const base = `/api/clip/${est.trabajo}/${c.n}`;
    const url = `${base}?v=${c.v || 0}`;          // el "v" evita que el navegador muestre la copia vieja
    const botonPublicar = puedePublicar
      ? el('button', { type: 'button', class: 'sec', text: '🚀 Publicar', onclick: () => abrirPublicar(c.n) })
      : null;
    lista.append(el('div', { class: 'clip' },
      el('video', { src: url, controls: true, preload: 'metadata', playsinline: true }),
      el('div', { class: 'datos' },
        el('b', { text: `Clip ${c.n}` }), el('br'),
        el('small', { text: `${c.duracion} s · desde ${formatoTiempo(c.inicio)}${c.editado ? ' · editado' : ''}` }),
        el('div', { class: 'acciones' },
          el('button', { type: 'button', text: '✏️ Editar', onclick: () => abrirEditor(c.n) }),
          el('a', { class: 'boton', href: `${base}?descargar=1&v=${c.v || 0}`, text: '⬇️ MP4' }),
          el('button', { type: 'button', class: 'sec', text: '📤 Compartir', onclick: ev => compartir(url, c.n, ev.currentTarget) }),
          botonPublicar,
        ))));
  });
}

function iniciarCuenta() {
  clearInterval(est.temporizador);
  const pintar = () => {
    const s = Math.round((est.finEn - Date.now()) / 1000);
    if (s <= 0) { $('cuenta').textContent = 'Los clips ya se borraron. Crea unos nuevos.'; clearInterval(est.temporizador); return; }
    $('cuenta').textContent = `⏱ Se borran solos en ${formatoTiempo(s)}. Descárgalos antes.`;
  };
  pintar();
  est.temporizador = setInterval(pintar, 1000);
}

// Compartir: en el celular abre el menú del sistema (TikTok, Instagram, WhatsApp...)
async function compartir(url, n, boton) {
  const texto = boton.textContent;
  boton.disabled = true; boton.textContent = 'Preparando...';
  try {
    const blob = await (await fetch(url)).blob();
    const archivo = new File([blob], `clip_${n}.mp4`, { type: 'video/mp4' });
    if (navigator.canShare && navigator.canShare({ files: [archivo] })) await navigator.share({ files: [archivo], title: 'Mi clip' });
    else avisar('Tu navegador no permite compartir directo. Descarga el MP4 y súbelo a tu red social.');
  } catch (e) {
    if (e.name !== 'AbortError') avisar('No se pudo compartir. Prueba descargando el MP4.', 'error');
  } finally { boton.disabled = false; boton.textContent = texto; }
}

// ======================================================================
//  REDES SOCIALES
// ======================================================================
async function cargarRedes() {
  const r = await api('/api/redes');
  est.redes = r.ok ? r.datos : [];
  const tarjeta = $('tarjetaRedes'), lista = $('listaRedes');
  lista.replaceChildren();
  if (!est.yo.plan.publicar) {
    tarjeta.classList.remove('oculto');
    lista.append(el('p', { text: 'Publica tus clips en YouTube, TikTok e Instagram con un solo clic.' }),
      el('button', { type: 'button', class: 'sec', text: '🔒 Disponible en el plan Pro', onclick: () => $('btnMejorar').click() }));
    $('notaRedes').textContent = '';
    return;
  }
  if (!est.redes.length) return tarjeta.classList.add('oculto');
  tarjeta.classList.remove('oculto');
  est.redes.forEach(x => {
    lista.append(el('div', { class: 'redes-fila' },
      el('div', {}, el('b', { text: x.etiqueta }), el('br'),
        el('small', { text: x.conectada ? `Conectado${x.nombre ? ' · ' + x.nombre : ''}` : 'Sin conectar' })),
      x.conectada
        ? el('button', { type: 'button', class: 'sec peq', text: 'Desconectar', onclick: async () => { await api('/api/redes/' + x.red, { method: 'DELETE' }); cargarRedes(); } })
        : el('a', { class: 'boton peq', href: `/api/redes/${x.red}/conectar`, text: 'Conectar' }),
    ));
  });
  const tt = est.redes.find(x => x.red === 'tiktok');
  $('notaRedes').textContent = tt && tt.modo === 'borrador' ? 'En TikTok, el clip llega a tus borradores y lo publicas desde la app.' : '';
}

function abrirPublicar(n) {
  const conectadas = est.redes.filter(x => x.conectada);
  if (!conectadas.length) { avisar('Primero conecta una red social en la sección de abajo.', 'error'); $('tarjetaRedes').scrollIntoView({ behavior: 'smooth' }); return; }
  est.pubClip = n;
  $('tituloPublicar').textContent = `Publicar clip ${n}`;
  $('pubRed').replaceChildren(...conectadas.map(x => el('option', { value: x.red, text: x.etiqueta })));
  $('pubTitulo').value = `Mi clip ${n}`; $('pubDesc').value = '';
  $('pubMsg').textContent = ''; $('pubMsg').className = 'msg';
  $('pubEnviar').disabled = false;
  cambiarRedPublicar();
  $('dlgPublicar').showModal();
}
function cambiarRedPublicar() { $('bloquePriv').classList.toggle('oculto', $('pubRed').value !== 'youtube'); }
$('pubRed').onchange = cambiarRedPublicar;
$('pubCancelar').onclick = () => $('dlgPublicar').close();

$('formPublicar').addEventListener('submit', async e => {
  e.preventDefault();
  $('pubEnviar').disabled = true;
  $('pubMsg').className = 'msg'; $('pubMsg').textContent = 'Publicando... puede tardar un poco, no cierres la página.';
  const r = await api('/api/publicar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trabajo: est.trabajo, n: est.pubClip, red: $('pubRed').value, titulo: $('pubTitulo').value, descripcion: $('pubDesc').value, privacidad: $('pubPriv').value }),
  });
  $('pubEnviar').disabled = false;
  if (!r.ok) { $('pubMsg').className = 'msg error'; $('pubMsg').textContent = r.datos.error || 'No se pudo publicar'; return; }
  $('pubMsg').className = 'msg ok'; $('pubMsg').replaceChildren(r.datos.mensaje || 'Publicado');
  if (r.datos.url) $('pubMsg').append(' ', el('a', { href: r.datos.url, target: '_blank', rel: 'noopener', text: 'Abrir', style: 'color:#fff' }));
});

// ======================================================================
//  INSTALAR COMO APP (PWA)
// ======================================================================
let eventoInstalar = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); eventoInstalar = e;
  $('btnInstalar').classList.remove('oculto'); $('btnInstalar2').classList.remove('oculto');
});
async function instalar() {
  if (!eventoInstalar) return;
  eventoInstalar.prompt(); await eventoInstalar.userChoice; eventoInstalar = null;
  $('btnInstalar').classList.add('oculto'); $('btnInstalar2').classList.add('oculto');
}
$('btnInstalar').onclick = instalar; $('btnInstalar2').onclick = instalar;
window.addEventListener('appinstalled', () => { $('btnInstalar').classList.add('oculto'); $('btnInstalar2').classList.add('oculto'); });

// En iPhone no hay botón automático: mostramos la explicación
const esIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const instalada = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (esIos && !instalada) $('ayudaIos').classList.remove('oculto');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ======================================================================
//  Mensajes que vuelven de pagos y redes (?pago=ok, ?red=ok ...)
// ======================================================================
(function leerRetorno() {
  const q = new URLSearchParams(location.search);
  const mensajes = {
    'pago=ok': ['✅ ¡Pago recibido! En unos segundos tu acceso queda activo. Entra con tu correo y contraseña.', 'ok'],
    'pago=cancelado': ['El pago fue cancelado. No se cobró nada.', 'info'],
    'pago=error': ['No pudimos confirmar el pago. Si te cobraron, escríbenos y lo activamos.', 'error'],
    'red=ok': ['✅ Cuenta conectada. Ya puedes publicar tus clips.', 'ok'],
    'red=error': ['No se pudo conectar la cuenta. Intenta de nuevo.', 'error'],
  };
  for (const k of ['pago', 'red']) {
    const m = mensajes[`${k}=${q.get(k)}`];
    if (m) { avisar(m[0], m[1]); history.replaceState(null, '', location.pathname); break; }
  }
})();


// ======================================================================
//  EDITOR DE CLIPS (texto, recorte, velocidad, sonido, subtítulos)
//  Los cambios se aplican en el servidor con ffmpeg; aquí solo se arma
//  el formulario y una vista previa aproximada.
// ======================================================================
const ED_TAMANOS = { chico: 0.03, medio: 0.045, grande: 0.065 };      // igual que editor.js del servidor
const ED_COLORES = { blanco: '#ffffff', amarillo: '#ffe600', rojo: '#ff3b3b', verde: '#35e04a', celeste: '#27d9ff', naranja: '#ff9d1f', negro: '#000000' };
const ED_VELOCIDADES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ED_MAX_LINEAS = 20;

const ed = { n: null, clip: null, textos: [], subs: [], vel: 1, ocupado: false };

const edNum = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const edDuracionOrig = () => $('edVideo').duration || (ed.clip ? ed.clip.duracion : 0) || 0;
// Duración del clip ya editado (con recorte y velocidad)
function edDurFinal() {
  const d = edNum($('edDesde').value) ?? 0, h = edNum($('edHasta').value) ?? edDuracionOrig();
  return Math.max(0, (h - d) / ed.vel);
}

function abrirEditor(n) {
  const c = est.clips.find(x => x.n === n);
  if (!c) return;
  ed.n = n; ed.clip = c;
  const aj = c.ajustes || {};
  ed.vel = aj.velocidad || 1;
  ed.textos = (aj.textos || []).map(t => ({ texto: t.texto, pos: t.pos, tam: t.tam, color: t.color, fondo: !!t.fondo, desde: t.desde, hasta: t.hasta }));
  ed.subs = (aj.subtitulos || []).map(t => ({ texto: t.texto, desde: t.desde, hasta: t.hasta }));
  $('tituloEditor').textContent = `Editar clip ${n}`;
  $('edMsg').textContent = ''; $('edMsg').className = 'msg';
  $('edDesde').value = aj.recorte ? aj.recorte.desde : 0;
  $('edHasta').value = aj.recorte ? aj.recorte.hasta : c.duracion;
  $('edVolumen').value = aj.volumen != null ? aj.volumen : 100;
  const v = $('edVideo');
  // Vista previa con el clip ORIGINAL (sin editar): así se puede recortar y cambiar todo de nuevo
  v.src = `/api/clip/${est.trabajo}/${n}?original=1&v=${c.v || 0}`;
  v.onloadedmetadata = () => {
    if (!aj.recorte) $('edHasta').value = Math.round(v.duration * 10) / 10;
    edActualizar();
  };
  pintarVelocidades(); pintarTextos(); pintarSubs();
  edActualizar();
  $('dlgEditor').showModal();
}

function cerrarEditor() {
  const v = $('edVideo');
  v.pause(); v.removeAttribute('src'); v.load();
  $('dlgEditor').close();
}
$('edCerrar').onclick = cerrarEditor;

// ---------- Velocidad ----------
function pintarVelocidades() {
  $('edVel').replaceChildren(...ED_VELOCIDADES.map(x => el('button', {
    type: 'button', class: x === ed.vel ? 'on' : '', text: x + '×',
    onclick: () => { ed.vel = x; pintarVelocidades(); edActualizar(); },
  })));
}

// ---------- Sonido ----------
$('edVolumen').oninput = edActualizar;
$('edSilenciar').onclick = () => { $('edVolumen').value = $('edVolumen').value === '0' ? 100 : 0; edActualizar(); };

// ---------- Recorte ----------
$('edDesde').oninput = $('edHasta').oninput = edActualizar;
$('edMarcarIni').onclick = () => { $('edDesde').value = Math.round($('edVideo').currentTime * 10) / 10; edActualizar(); };
$('edMarcarFin').onclick = () => { $('edHasta').value = Math.round($('edVideo').currentTime * 10) / 10; edActualizar(); };

// ---------- Textos ----------
function selectDe(opciones, valor, alCambiar) {
  const s = el('select', {}, ...opciones.map(([v, t]) => el('option', { value: v, text: t })));
  s.value = valor; s.onchange = () => alCambiar(s.value);
  return s;
}
const campoTiempo = (valor, ph, alCambiar) => {
  const i = el('input', { type: 'number', min: '0', step: '0.1', inputmode: 'decimal', placeholder: ph });
  i.value = valor == null ? '' : valor;
  i.oninput = () => alCambiar(i.value === '' ? null : edNum(i.value));
  return i;
};

function pintarTextos() {
  const cont = $('edTextos');
  cont.replaceChildren(...ed.textos.map((t, i) => {
    const area = el('textarea', { rows: '2', maxlength: '200', placeholder: 'Escribe tu texto aquí' });
    area.value = t.texto; area.oninput = () => { t.texto = area.value; edActualizar(); };
    const fondo = el('input', { type: 'checkbox' });
    fondo.checked = t.fondo; fondo.onchange = () => { t.fondo = fondo.checked; edActualizar(); };
    return el('div', { class: 'ed-item' },
      area,
      el('div', { class: 'ed-fila3' },
        selectDe([['arriba', 'Arriba'], ['centro', 'Centro'], ['abajo', 'Abajo']], t.pos, v => { t.pos = v; edActualizar(); }),
        selectDe([['chico', 'Letra chica'], ['medio', 'Letra media'], ['grande', 'Letra grande']], t.tam, v => { t.tam = v; edActualizar(); }),
        selectDe([['blanco', 'Blanco'], ['amarillo', 'Amarillo'], ['rojo', 'Rojo'], ['verde', 'Verde'], ['celeste', 'Celeste'], ['naranja', 'Naranja'], ['negro', 'Negro']], t.color, v => { t.color = v; edActualizar(); }),
      ),
      el('label', { class: 'ed-check' }, fondo, ' Fondo oscuro detrás del texto'),
      el('div', { class: 'ed-fila2' },
        campoTiempo(t.desde, 'Desde (s)', v => { t.desde = v; edActualizar(); }),
        campoTiempo(t.hasta, 'Hasta (s)', v => { t.hasta = v; edActualizar(); }),
      ),
      el('small', { text: 'Si dejas los tiempos vacíos, el texto se ve en todo el clip.' }),
      el('button', { type: 'button', class: 'sec peq', text: 'Quitar este texto', onclick: () => { ed.textos.splice(i, 1); pintarTextos(); edActualizar(); } }),
    );
  }));
}
$('edAgregarTexto').onclick = () => {
  if (ed.textos.length + ed.subs.length >= ED_MAX_LINEAS) return avisar(`Máximo ${ED_MAX_LINEAS} textos y subtítulos por clip.`, 'error');
  ed.textos.push({ texto: '', pos: 'abajo', tam: 'medio', color: 'blanco', fondo: true, desde: null, hasta: null });
  pintarTextos();
};

// ---------- Subtítulos ----------
// Momento actual de la vista previa, ya contado en el clip editado (con recorte y velocidad)
function edMomentoActual() {
  const d = edNum($('edDesde').value) ?? 0;
  return Math.max(0, Math.round((($('edVideo').currentTime - d) / ed.vel) * 10) / 10);
}
function pintarSubs() {
  const cont = $('edSubs');
  cont.replaceChildren(...ed.subs.map((t, i) => {
    const txt = el('input', { type: 'text', maxlength: '200', placeholder: 'Frase del subtítulo' });
    txt.value = t.texto; txt.oninput = () => { t.texto = txt.value; edActualizar(); };
    const desde = campoTiempo(t.desde, 'Desde (s)', v => { t.desde = v; edActualizar(); });
    const hasta = campoTiempo(t.hasta, 'Hasta (s)', v => { t.hasta = v; edActualizar(); });
    return el('div', { class: 'ed-item' },
      txt,
      el('div', { class: 'ed-fila2' }, desde, hasta),
      el('div', { class: 'ed-botones' },
        el('button', { type: 'button', class: 'sec peq', text: 'Empieza aquí', onclick: () => { t.desde = edMomentoActual(); desde.value = t.desde; edActualizar(); } }),
        el('button', { type: 'button', class: 'sec peq', text: 'Termina aquí', onclick: () => { t.hasta = edMomentoActual(); hasta.value = t.hasta; edActualizar(); } }),
        el('button', { type: 'button', class: 'sec peq', text: 'Quitar', onclick: () => { ed.subs.splice(i, 1); pintarSubs(); edActualizar(); } }),
      ));
  }));
}
$('edAgregarSub').onclick = () => {
  if (ed.textos.length + ed.subs.length >= ED_MAX_LINEAS) return avisar(`Máximo ${ED_MAX_LINEAS} textos y subtítulos por clip.`, 'error');
  const previo = ed.subs[ed.subs.length - 1];
  const ini = previo && previo.hasta != null ? previo.hasta : edMomentoActual();
  ed.subs.push({ texto: '', desde: ini, hasta: Math.round((ini + 2) * 10) / 10 });
  pintarSubs();
};

// ---------- Vista previa ----------
// Dibuja encima del video los textos que tocan en este instante
function edPintarCapa() {
  const capa = $('edCapa'), marco = $('edMarco');
  const alto = marco.clientHeight || 400;
  const d = edNum($('edDesde').value) ?? 0;
  const tf = ($('edVideo').currentTime - d) / ed.vel;          // segundo dentro del clip ya editado
  const lineas = [
    ...ed.textos.map(t => ({ ...t, sub: false })),
    ...ed.subs.map(t => ({ texto: t.texto, pos: 'abajo', tam: 'medio', color: 'blanco', fondo: true, desde: t.desde, hasta: t.hasta, sub: true })),
  ].filter(l => l.texto && l.texto.trim() &&
    (l.desde == null || tf >= l.desde) && (l.hasta == null || tf <= l.hasta));
  capa.replaceChildren(...lineas.map(l => el('div', {
    class: 'ed-linea ed-' + l.pos + (l.sub ? ' ed-sub' : ''),
    text: l.texto,
    style: `font-size:${Math.round(alto * ED_TAMANOS[l.tam])}px;color:${ED_COLORES[l.color]};` +
      (l.fondo ? 'background:rgba(0,0,0,.6);padding:.25em .45em;border-radius:4px;' : 'text-shadow:0 0 3px #000,0 0 3px #000,0 0 3px #000;'),
  })));
}

// Pone al día todo lo que depende de los controles
function edActualizar() {
  const v = $('edVideo');
  const vol = parseInt($('edVolumen').value, 10);
  $('edVolumenTxt').textContent = vol === 0 ? 'sin sonido' : vol + ' %';
  $('edSilenciar').textContent = vol === 0 ? 'Poner el sonido' : 'Quitar el sonido';
  v.playbackRate = ed.vel;
  v.volume = Math.min(1, vol / 100); v.muted = vol === 0;
  const dur = edDurFinal();
  $('edDurFinal').textContent = dur > 0 ? `${dur.toFixed(1)} s` : '-';
  edPintarCapa();
}
// La vista previa se queda dentro del tramo recortado
$('edVideo').addEventListener('timeupdate', () => {
  const v = $('edVideo');
  const d = edNum($('edDesde').value) ?? 0, h = edNum($('edHasta').value) ?? v.duration;
  if (!v.paused && v.currentTime >= h) { v.pause(); v.currentTime = d; }
  edPintarCapa();
});
$('edVideo').addEventListener('play', () => {
  const v = $('edVideo');
  const d = edNum($('edDesde').value) ?? 0, h = edNum($('edHasta').value) ?? v.duration;
  if (v.currentTime < d || v.currentTime >= h) v.currentTime = d;
  v.playbackRate = ed.vel;
});
$('edVideo').addEventListener('seeked', edPintarCapa);

// ---------- Aplicar y volver al original ----------
function edMensaje(texto, tipo) { $('edMsg').textContent = texto; $('edMsg').className = 'msg' + (tipo ? ' ' + tipo : ''); }
function edBloquear(si) { ed.ocupado = si; $('edAplicar').disabled = si; $('edRestaurar').disabled = si; $('edCerrar').disabled = si; }

function edPedido() {
  const volumen = parseInt($('edVolumen').value, 10);
  return {
    recorte: { desde: edNum($('edDesde').value) ?? 0, hasta: edNum($('edHasta').value) ?? edDuracionOrig() },
    velocidad: ed.vel, volumen,
    textos: ed.textos.filter(t => t.texto.trim()),
    subtitulos: ed.subs.filter(t => t.texto.trim()),
  };
}

async function edEnviar(url, cuerpo, mensajeEspera, mensajeOk) {
  if (ed.ocupado) return;
  edBloquear(true); edMensaje(mensajeEspera, '');
  const r = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo || {}) });
  edBloquear(false);
  if (!r.ok) return edMensaje(r.datos.error || 'No se pudo editar el clip. Intenta de nuevo.', 'error');
  const i = est.clips.findIndex(x => x.n === ed.n);
  if (i >= 0) est.clips[i] = r.datos.clip;
  pintarLista();
  cerrarEditor();
  avisar(mensajeOk, 'ok');
}

$('edAplicar').onclick = () => {
  if (edDurFinal() < 1) return edMensaje('El clip debe durar al menos 1 segundo. Revisa "Empieza en" y "Termina en".', 'error');
  edEnviar(`/api/editar/${est.trabajo}/${ed.n}`, edPedido(), 'Aplicando los cambios... puede tardar unos segundos.', '✅ Clip editado. Ya puedes descargarlo.');
};
$('edRestaurar').onclick = () =>
  edEnviar(`/api/editar/${est.trabajo}/${ed.n}/restaurar`, {}, 'Volviendo al original...', 'El clip volvió a su versión original.');
$('dlgEditor').addEventListener('cancel', e => { if (ed.ocupado) e.preventDefault(); });

iniciar();
