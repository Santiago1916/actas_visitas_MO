create extension if not exists pgcrypto;

create table if not exists public.actas_visita (
  id uuid primary key default gen_random_uuid(),
  acta_code text not null unique,
  fecha date not null,
  razon_social text not null,
  sede text not null,
  hora_inicio time,
  hora_fin time,
  contacto_empresa text,
  telefono text,
  email text,
  participantes text,
  temas_tratados text,
  compromisos text,
  observaciones text,
  latitud double precision,
  longitud double precision,
  ubicacion_capturada_at timestamptz,
  drive_file_id text,
  drive_file_name text,
  drive_web_view_link text,
  drive_web_content_link text,
  drive_year_folder text,
  drive_month_folder text,
  drive_week_folder text,
  drive_week_of_month integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint actas_visita_week_chk check (drive_week_of_month is null or drive_week_of_month between 1 and 6)
);

create index if not exists idx_actas_visita_fecha on public.actas_visita (fecha desc);
create index if not exists idx_actas_visita_sede on public.actas_visita (sede);
create index if not exists idx_actas_visita_drive_file_id on public.actas_visita (drive_file_id);
create index if not exists idx_actas_visita_month_week on public.actas_visita (drive_month_folder, drive_week_of_month);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_actas_visita_updated_at on public.actas_visita;
create trigger trg_actas_visita_updated_at
before update on public.actas_visita
for each row
execute function public.set_updated_at();
