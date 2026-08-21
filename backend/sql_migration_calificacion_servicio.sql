alter table if exists public.actas_visita
  add column if not exists calificacion_servicio smallint;

alter table public.actas_visita
  drop constraint if exists actas_visita_calificacion_chk;

alter table public.actas_visita
  add constraint actas_visita_calificacion_chk
  check (calificacion_servicio is null or calificacion_servicio between 1 and 5);
