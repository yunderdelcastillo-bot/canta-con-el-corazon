-- Habilita los eventos usados por el contador de clientes activos.
-- Ejecutar una sola vez en Supabase > SQL Editor.
-- Conserva los cuatro eventos existentes y agrega los tres del seguimiento en vivo.
alter table public.system_notifications
 drop constraint if exists system_notifications_event_type_check;

alter table public.system_notifications
 add constraint system_notifications_event_type_check
 check (event_type in (
  'new_order',
  'voucher_received',
  'new_message',
  'payment_approved',
  'form_started',
  'form_left',
  'form_submitted'
 ));

notify pgrst, 'reload schema';
