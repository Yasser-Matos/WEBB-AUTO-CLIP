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
| `db.js` | Base de datos de usuarios | No |
| `zip.js` | Descargar todos los clips juntos | No |
| `public/` | Lo que ve el usuario (`index.html`, `estilos.css`, `app.js`, iconos) | Colores en `estilos.css` |

## Cambiar precios y planes
Abre `config.js`. En `PLANES` cambia `precioUSD`, `videosPorMes`, `maxClips`, `maxDuracion`, `logo` (true/false) y `publicar` (true/false). Cada pago da `DIAS_POR_COMPRA` días (30).

## Subir a Railway (paso a paso)

1. Sube la carpeta a GitHub (con `public/` adentro) y conéctala a Railway como siempre.
2. **Volume (importante):** en Railway, agrega un *Volume* montado en `/data` y pon la variable `DB_PATH` = `/data/data.db`. **Sin esto, los usuarios y pagos se borran cada vez que Railway redespliega.**
3. En **Variables** agrega:

| Variable | Valor |
|---|---|
| `JWT_SECRET` | Una clave larga inventada por ti (obligatoria) |
| `ADMIN_KEY` | Tu clave secreta para crear usuarios a mano |
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
En PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri "https://TU-DIRECCION/api/admin/usuario" -ContentType "application/json" -Body '{"clave":"TU_ADMIN_KEY","email":"cliente@correo.com","password":"clave123","dias":30,"plan":"pro"}'
```

## Publicar directo en redes (plan Pro)
Cada red exige que crees una "app" de desarrollador y que la aprueben antes de publicar para el público. Sin aprobación funciona solo para tu propia cuenta de prueba. La dirección de retorno (redirect URI) de cada una es `https://TU-DIRECCION/api/redes/NOMBRE/callback`.

| Red | Variables | `NOMBRE` | Notas |
|---|---|---|---|
| YouTube | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `youtube` | Activa "YouTube Data API v3". Hasta que Google audite tu app, los videos subidos quedan **privados**. |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_MODO` (`borrador` o `directo`) | `tiktok` | En `borrador` el clip llega a los borradores de TikTok del usuario. `directo` requiere aprobación de TikTok. |
| Instagram | `META_APP_ID`, `META_APP_SECRET` | `instagram` | Solo cuentas profesionales ligadas a una página de Facebook. Necesita revisión de Meta. |

Solo aparecen en la web las redes cuyas variables pongas.

## Qué está probado y qué no
**Probado aquí con ffmpeg y navegador reales:** cortes en los 3 formatos, logo en las 5 posiciones, "mejores momentos", partes iguales, cola de espera, ZIP, planes y límites, activación única de pagos, firma de Stripe, migración de la base anterior, y la pantalla completa (botones +/−, atajos, planes, resultados).

**No pude probar aquí:** el servidor completo levantado con Express (no pude instalar paquetes) ni las llamadas reales a Stripe, PayPal, YouTube, TikTok e Instagram (necesitan tus claves). Al subirlo, haz primero una compra de prueba (Stripe en modo test / PayPal sandbox) y un clip de prueba antes de vender.

## Aviso legal
Descargar videos por link de plataformas como YouTube puede ir contra sus términos o los derechos de autor. Conviene que tus términos de uso indiquen que el usuario solo use videos propios o con permiso.
