alter table if exists public.actas_visita
  add column if not exists encargado_empresa_nombre text,
  add column if not exists acepta_condiciones_datos boolean not null default false;
