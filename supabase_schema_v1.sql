-- =========================================================
-- Bimbo Inventory Pro — Esquema Fase 1: roles y perfiles
-- Ejecutar completo en Supabase: Dashboard > SQL Editor > New query
-- =========================================================

-- 1) Tipos
create type public.user_role as enum ('admin','corporativo','route');
create type public.user_estado as enum ('activo','pendiente');

-- 2) Tabla de perfiles (1 fila por usuario, ligada a auth.users)
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text,
  role public.user_role not null default 'route',
  route_code text,           -- solo aplica si role = 'route'
  puesto text,               -- MSL / ZSL / OSL, solo si role = 'corporativo'
  creado_por uuid references public.profiles(id),
  estado public.user_estado not null default 'activo',
  aprobado_por uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- 3) Función auxiliar (evita recursión infinita en las políticas RLS)
create or replace function public.current_user_role()
returns public.user_role
language sql
security definer
stable
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- 4) Políticas RLS

-- Cada quien puede ver su propio perfil; Admin y Corporativo ven todos.
create policy "profiles_select" on public.profiles
  for select using (
    auth.uid() = id
    or public.current_user_role() in ('admin','corporativo')
  );

-- Admin puede crear cualquier rol.
create policy "profiles_insert_admin" on public.profiles
  for insert with check (
    public.current_user_role() = 'admin'
  );

-- Corporativo solo puede crear perfiles de tipo 'route'.
create policy "profiles_insert_corporativo_route" on public.profiles
  for insert with check (
    role = 'route'
    and public.current_user_role() = 'corporativo'
  );

-- Admin puede actualizar cualquier perfil (aprobar rutas, cambiar datos, etc).
create policy "profiles_update_admin" on public.profiles
  for update using (
    public.current_user_role() = 'admin'
  );

-- Cada quien puede actualizar su propio nombre (no su role/estado).
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- Solo Admin puede borrar, y nunca una fila con role = 'admin'.
create policy "profiles_delete_admin_not_admin" on public.profiles
  for delete using (
    role <> 'admin'
    and public.current_user_role() = 'admin'
  );

-- =========================================================
-- BOOTSTRAP: crear el primer usuario Admin
-- =========================================================
-- 1. Ve a Authentication > Users > Add user en el Dashboard de Supabase.
--    Crea el usuario con el correo y contraseña del primer Admin.
-- 2. Copia el UUID de ese usuario (columna "UID" en la tabla de Users).
-- 3. Reemplaza 'PEGA-AQUI-EL-UUID' abajo y ejecuta este INSERT:

-- insert into public.profiles (id, nombre, role, estado)
-- values ('PEGA-AQUI-EL-UUID', 'Nombre del Admin', 'admin', 'activo');
