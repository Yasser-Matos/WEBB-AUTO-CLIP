# VideoClips — guía rápida

Web para cortar un video (link o archivo) en varios clips. Todo en JavaScript (Node).
Los videos **no se guardan**: el original se borra al terminar y los clips a los 20 minutos.

## Qué hay en cada archivo

| Archivo | Para qué sirve | ¿Lo vas a editar? |
|---|---|---|
| `config.js` | **Precios, planes y límites** | **Sí, este es el principal** |
| `server.js` | Conecta todo (rutas de la web) | Casi nunca |
| `cortador.js` | Decide dónde y cómo se corta cada clip | Casi nunca |
| `analisis.js` | Encuentra los "mejores momentos" | Casi nunca |
| `cola.js` | Fila de espera si hay muchos videos | No |
| `pagos.js` | Cobro con Stripe y PayPal | No |
| `redes.js` | Publicar en YouTube, TikTok, Instagram | No |
| `db.js` | Base de datos de usuarios, pagos y ajustes | No |
| `panel.js` | Servidor del panel de administración | No |
| `zip.js` | Descargar todos los clips juntos | No |
| `public/` | Lo que ve el usuario (`index.html`, `estilos.css`, `app.js`, iconos) | Colores en `estilos.css` |
| `public/admin.html/.css/.js` | Pantalla del panel de administración | Colores en `admin.css` (arriba) |

## Cambiar precios y planes
Abre `config.js`. En `PLANES` cambia `precioUSD`, `videosPorMes`, `maxClips`, `maxDuracion`, `logo` (true/false) y `publicar` (true/false). Cada pago da `DIAS_POR_COMPRA` días (30).

## Panel de administración (`/admin`)
Entra a `https://TU-DIRECCION/admin` y escribe tu `ADMIN_KEY`. Tiene cinco pantallas:

- **Inicio:** cuánta gente usó la web este mes, cuántos tienen cada plan, **"La caja"** (dinero cobrado este mes, últimas ventas y total guardado hasta hoy), gráficas por mes, planes que vencen esta semana y pruebas por terminar.
- **Usuarios:** busca por correo y filtra por estado o plan. Al tocar a alguien se abre su ficha: dar más días o fijar la fecha de vencimiento, cambiar plan, cambiar correo o contraseña, reiniciar su conteo de videos, bloquear o eliminar. También **anotar un cobro** en efectivo o transferencia (se suma a las ventas y renueva el acceso) y **crear usuarios nuevos**.
- **Ventas:** cada compra con fecha, cliente, plan, cómo pagó y monto; total del mes, mes pasado, total acumulado y venta promedio; botón para descargar a Excel. Una compra "Sin terminar" no cuenta como dinero cobrado.
- **Planes y precios:** cambia nombre, precio y límites de cada plan y de la prueba gratis sin tocar el código (se guarda en la base de datos). Un cambio de precio solo afecta compras nuevas.
- **Estado del sistema:** revisa si falta alguna variable (Stripe, PayPal, URL, etc.).

## Prueba gratis
Quien se registra desde la pestaña "Prueba gratis" recibe `PRUEBA.dias` días y los límites del plan `prueba` (3 videos en total, 5 clips, 30 s, sin logo ni publicar). Solo se puede usar **una vez por correo** (se ignoran los puntos de Gmail y los +alias) y máximo 2 por día desde la misma conexión. Puedes apagarla o cambiarla desde **Planes y precios**. Los días de prueba no se suman al comprar un plan. Aún no se verifica el correo con un enlace.

## Subir a Railway (paso a paso)

1. Sube la carpeta a GitHub (con `public/` adentro) y conéctala a Railway como siempre.
2. **Volume (importante):** en Railway, agrega un *Volume* montado en `/data` y pon la variable `DB_PATH` = `/data/data.db`. **Sin esto, los usuarios y pagos se borran cada vez que Railway redespliega.**
3. En **Variables** agrega:

| Variable | Valor |
|---|---|
| `JWT_SECRET` | Una clave larga inventada por ti (obligatoria) |
| `ADMIN_KEY` | Tu clave del panel `/admin` (larga y secreta) |
| `NODE_ENV` | `production` |
| `URL_PUBLICA` | Tu dirección, ej. `https://tuapp.up.railway.app` |

4. `nixpacks.toml` ya le dice a Railway que instale ffmpeg y yt-dlp.
5. Railway cobra por uso de CPU. Cortar video consume bastante: vigila el gasto.

## Cobros automáticos (usa los que quieras)

**Stripe** (tarjetas)
1. Variables: `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET`.
2. En Stripe → Desarrolladores → Webhooks, agrega la dirección `https://TU-DIRECCION/api/pago/stripe/webhook` con el evento `checkout.session.completed` (y `checkout.session.async_payment_succeeded`). Copia el "signing secret" a `STRIPE_WEBHOOK_SECRET`.
3. Prueba primero con las claves de prueba (`sk_test_...`). Verifica que Stripe esté disponible para tu país/negocio.

**PayPal**
1. Variables: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`.
2. Empieza en modo prueba (sandbox). Para cobrar de verdad agrega `PAYPAL_MODO` = `live` y usa las claves *Live*.

Si no pones ninguna, la pestaña "Comprar acceso" avisa que las compras no están activadas (y puedes crear usuarios a mano, ver abajo).

## Crear un usuario a mano (regalo o venta directa)
Lo más fácil: panel → **Usuarios → Nuevo usuario**. Genera la contraseña y te da un mensaje listo para copiar y enviar al cliente. Si pones cuánto pagó, se anota en Ventas.

## Publicar directo en redes (plan Pro)
Cada red exige que crees una "app" de desarrollador y que la aprueben antes de publicar para el público. Sin aprobación funciona solo para tu propia cuenta de prueba. La dirección de retorno (redirect URI) de cada una es `https://TU-DIRECCION/api/redes/NOMBRE/callback`.

| Red | Variables | `NOMBRE` | Notas |
|---|---|---|---|
| YouTube | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `youtube` | Activa "YouTube Data API v3". Hasta que Google audite tu app, los videos subidos quedan **privados**. |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_MODO` (`borrador` o `directo`) | `tiktok` | En `borrador` el clip llega a los borradores de TikTok del usuario. `directo` requiere aprobación de TikTok. |
| Instagram | `META_APP_ID`, `META_APP_SECRET` | `instagram` | Solo cuentas profesionales ligadas a una página de Facebook. Necesita revisión de Meta. |

Solo aparecen en la web las redes cuyas variables pongas.

## Qué está probado y qué no
**Probado con ffmpeg y navegador reales:** cortes en los 3 formatos, logo, "mejores momentos", cola, ZIP, planes y límites, activación única de pagos, firma de Stripe, prueba gratis (registro, anti-repetición y límites) y las acciones del panel (cambiar correo, fijar fecha, anotar cobro, crear con monto, resumen de ventas).

**Panel (pantallas):** revisadas en navegador real a 1366 px y celular con datos de ejemplo. Después se reinició mi entorno y tuve que reconstruir `admin.css`; esa versión la vi con datos de ejemplo, pero **no** contra el servidor completo.

**No pude probar:** el servidor levantado con Express real ni las llamadas reales a Stripe, PayPal, YouTube, TikTok e Instagram. Al subirlo, haz primero una compra de prueba y un clip de prueba antes de vender.

## Aviso legal
Descargar videos por link de plataformas como YouTube puede ir contra sus términos o los derechos de autor. Conviene que tus términos de uso indiquen que el usuario solo use videos propios o con permiso.
