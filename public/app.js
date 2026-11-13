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
  $('tabComprar').classList.toggle('on', cual === 'comprar');
  $('formEntrar').classList.toggle('oculto', cual !== 'entrar');
  $('formComprar').classList.toggle('oculto', cual !== 'comprar');
}
$('tabEntrar').onclick = () => cambiarTabAcceso('entrar');
$('tabComprar').onclick = () => cambiarTabAcceso('comprar');

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
  const { planes, proveedores, dias } = est.planes;
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
  mostrar('acceso');
};
$('btnVolver').onclick = () => { $('tabEntrar').classList.remove('oculto'); $('btnVolver').classList.add('oculto'); mostrar('app'); };

// ======================================================================
//  APP: preparar pantalla según el plan
// ======================================================================
function prepararApp() {
  const { email, vence, plan, usoMes, limites } = est.yo;
  $('infoUsuario').textContent = email;
  $('planNombre').textContent = `Plan ${plan.nombre}`;
  $('planDetalle').textContent = `Acceso hasta ${vence} · ${usoMes} de ${plan.videosPorMes} videos este mes`;
  $('usoBarra').style.width = Math.min(100, (usoMes / plan.videosPorMes) * 100) + '%';

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
function prepararPlanBarra() {
  const { vence, plan, usoMes } = est.yo;
  $('planDetalle').textContent = `Acceso hasta ${vence} · ${usoMes} de ${plan.videosPorMes} videos este mes`;
  $('usoBarra').style.width = Math.min(100, (usoMes / plan.videosPorMes) * 100) + '%';
}

// ---------- Lista de clips ----------
function mostrarClips(t) {
  const cont = $('resultados');
  cont.classList.remove('oculto');
  $('btnZip').href = `/api/zip/${est.trabajo}`;
  $('btnZip').classList.toggle('oculto', t.clips.length < 2);
  est.finEn = Date.now() + (t.expiraEn || 0) * 1000;
  iniciarCuenta();

  const puedePublicar = est.yo.plan.publicar && est.redes.length > 0;
  const lista = $('listaClips');
  lista.replaceChildren();
  t.clips.forEach(c => {
    const url = `/api/clip/${est.trabajo}/${c.n}`;
    const botonPublicar = puedePublicar
      ? el('button', { type: 'button', class: 'sec', text: '🚀 Publicar', onclick: () => abrirPublicar(c.n) })
      : null;
    lista.append(el('div', { class: 'clip' },
      el('video', { src: url, controls: true, preload: 'metadata', playsinline: true }),
      el('div', { class: 'datos' },
        el('b', { text: `Clip ${c.n}` }), el('br'),
        el('small', { text: `${c.duracion} s · desde ${formatoTiempo(c.inicio)}` }),
        el('div', { class: 'acciones' },
          el('a', { class: 'boton', href: `${url}?descargar=1`, text: '⬇️ MP4' }),
          el('button', { type: 'button', class: 'sec', text: '📤 Compartir', onclick: ev => compartir(url, c.n, ev.currentTarget) }),
          botonPublicar,
        ))));
  });
  cont.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

iniciar();
