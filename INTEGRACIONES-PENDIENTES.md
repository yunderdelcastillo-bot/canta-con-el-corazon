# Integraciones futuras — Canta con el corazón

Las integraciones quedan preparadas, pero **no se ejecutan ni cobran/envían mensajes automáticamente** hasta configurarlas y probarlas.

## Migraciones Supabase
1. Ejecutar primero `supabase-payment-workflow.sql` si todavía no se ejecutó (habilita el token seguro del pedido y el flujo de voucher Yape).
2. Ejecutar después `supabase-messaging-notifications.sql` (crea conversaciones internas y notificaciones).
3. No volver a ejecutar migraciones ya aplicadas es necesario; los scripts usan `IF NOT EXISTS`.

## Culqi (pendiente)
Variables de entorno en Render API:
- `CULQI_PUBLIC_KEY`
- `CULQI_SECRET_KEY`
- `CULQI_WEBHOOK_SECRET`

La integración no está habilitada todavía. Antes de activar cobros se debe implementar y verificar el checkout, firma de webhook, idempotencia y conciliación de pagos. Nunca colocar claves secretas en la web pública ni enviarlas por chat.

## WhatsApp Cloud API (pendiente)
Variables de entorno en Render API:
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_BUSINESS_ACCOUNT_ID`
- `WHATSAPP_TEMPLATE_NAME`

La API no envía mensajes todavía. Se requiere configurar Meta Business, verificar el número, aprobar plantillas y luego implementar envío y recepción de webhooks. Mientras tanto siguen disponibles los enlaces manuales wa.me y la mensajería interna de pedidos.

## Funcionamiento actual
- Yape manual y envío de comprobante siguen siendo la alternativa.
- Chat interno por pedido entre cliente y administradora, protegido con el token de acceso del pedido.
- Alertas internas de nuevo pedido, voucher y mensaje.
- Sonido/voz del navegador en el panel; se activa manualmente por restricciones de reproducción automática. La voz disponible depende del dispositivo y navegador.
- El estado de preparación de Culqi y WhatsApp se muestra en el panel privado sin exponer secretos.
