# Plan: Login, Roles y Listas de Escaneo — Bimbo Inventory Pro

## 1. Objetivo

Pasar de una app que vive solo en `localStorage` del navegador a una app con login real, roles, y conteos guardados como "listas" (sesiones) que persisten entre aperturas y entre dispositivos. Backend: **Supabase** (Postgres + Auth).

## 2. Roles y permisos

| Acción | Admin | Corporativo (MSL/ZSL/OSL) | Route |
|---|---|---|---|
| Escanear / contar cajas | Sí | No (o solo consulta) | Sí, solo su ruta |
| Agregar / editar productos | Sí | No | No |
| Ver listas de su propia ruta | Sí | Sí | Sí |
| Ver listas de **todas** las rutas | Sí | Sí (solo lectura) | No |
| Exportar reportes consolidados (varias rutas) | Sí | Sí | No |
| Cerrar (forzar cierre) la lista de cualquier ruta | Sí | Sí | No, solo la propia |
| Ruta se autocompleta al iniciar sesión | N/A | N/A | Sí, viene del login |
| Agregar usuarios | Sí (Admin, Corporativo o Route) | Solo Route (no puede crear otro Corporativo ni Admin) | No |
| Borrar usuarios | Sí (cualquiera excepto Admin) | No | No |
| Borrar un Admin | **Nadie puede borrar una cuenta Admin** | — | — |
| Ruta creada por Corporativo | — | Queda en estado **pendiente de aprobación** | — |
| Aprobar ruta nueva | **Sí, solo Admin puede aprobar** | No | No |

**Nota:** cuando un Corporativo (MSL/ZSL/OSL) da de alta una ruta nueva, esa ruta/usuario Route queda en estado `pendiente` y no puede escanear todavía. Solo cuando un Admin la aprueba pasa a `activa`.

## 3. Modelo de datos (Supabase)

**profiles** (extiende `auth.users`)
- `id` (uuid, FK a auth.users)
- `nombre`
- `role` (`admin` \| `corporativo` \| `route`)
- `route_code` (solo si role = route)
- `puesto` (MSL / ZSL / OSL, solo si role = corporativo)
- `creado_por` (FK profiles.id — quién dio de alta este usuario)
- `estado` (`activo` \| `pendiente`) — una ruta creada por Corporativo nace en `pendiente`; Admin la pasa a `activo`
- `aprobado_por` (FK profiles.id, nullable — qué Admin la aprobó)

RLS clave para `profiles`:
- Insert: Admin puede crear cualquier rol. Corporativo solo puede crear filas con `role = route` (rechaza si intenta `corporativo` o `admin`).
- Delete: Admin puede borrar cualquier fila **excepto** las que tengan `role = admin`. Corporativo y Route no pueden borrar usuarios.
- Update `estado` a `activo`: solo Admin.

**products**
- `upc` (PK)
- `sku`, `nombre`, `unidades_caja`, `foto_url`
- `creado_por`, `actualizado_en`
- RLS: insert/update/delete solo `role = admin`. Lectura abierta a cualquier usuario autenticado.

**scan_sessions** (las "listas")
- `id` (uuid)
- `route_code`
- `user_id` (quién la abrió)
- `estado` (`abierta` \| `cerrada`)
- `abierta_en`, `cerrada_en`, `cerrada_por`

**scan_session_items**
- `id`, `session_id` (FK)
- `upc`, `sku`, `producto`, `unidades_caja`, `cajas`, `foto_url`

RLS clave:
- Route: lee/escribe solo `scan_sessions` de su propio `route_code`, y solo mientras `estado = abierta`.
- Corporativo: lee todas las sesiones; puede cambiar `estado` a `cerrada` en cualquiera.
- Admin: acceso total.

## 4. Ciclo de vida de una lista

1. El usuario Route entra → si tiene una lista `abierta`, la app la retoma tal cual (mismos productos/cantidades).
2. Si no tiene ninguna abierta, botón "Nueva lista" crea una `scan_session` con su `route_code`.
3. Salir de la pantalla de escaneo NO cierra la lista — sigue abierta y editable al volver a entrar.
4. Botón explícito "Cerrar lista" → `estado = cerrada`, `cerrada_en = now()`. A partir de ahí es de solo lectura (no +/-, no borrar, no editar cantidades).
5. Corporativo/Admin pueden forzar el cierre de una lista ajena (ej. si un conductor se le olvidó).

## 4.1 Alta y aprobación de rutas nuevas

1. Un Corporativo (MSL/ZSL/OSL) da de alta una ruta nueva → se crea el `profile` con `role = route`, `estado = pendiente`, `creado_por = <su id>`.
2. Esa ruta **no puede escanear** todavía (login bloqueado o en modo solo-consulta) mientras esté `pendiente`.
3. El Admin ve una bandeja de "rutas pendientes de aprobación" y las aprueba una por una → `estado = activo`, `aprobado_por = <admin id>`.
4. Si el Admin la rechaza, se puede borrar (Admin es el único que puede borrar usuarios, y nunca a otro Admin).

## 5. Pantalla de inicio (nueva)

En vez de ir directo al escáner, la home muestra un listado de sesiones:
- **Abiertas** (propias, para retomar).
- **Cerradas** (historial, solo consulta/exportar).
- Corporativo/Admin ven además un selector para filtrar por ruta.

## 6. Punto crítico: escaneo sin internet en bodega

Supabase necesita red. Si la señal en la bodega es mala, no se puede depender de guardar cada scan en vivo contra el servidor. Recomendación: modelo **local-first**:
- Cada scan se guarda primero en el dispositivo (local).
- Se sincroniza contra Supabase en segundo plano cuando hay conexión (cola con reintentos).
- Indicador visual de "sincronizado" vs "pendiente de subir".
- La lista solo se puede cerrar oficialmente cuando ya sincronizó (o se avisa que hay pendientes).

## 7. Fases de implementación

1. **Supabase setup**: proyecto, tablas, políticas RLS, Auth. Pantalla de login (usuario/contraseña o número de empleado).
2. **Gestión de usuarios y aprobación**: Admin crea/borra usuarios (nunca a otro Admin); Corporativo solo puede crear rutas nuevas, que nacen `pendiente` hasta que Admin las aprueba.
3. **Migrar productos**: la carga CSV pasa de guardar en `localStorage` a insertar en la tabla `products` (solo Admin).
4. **Modelo de listas**: nueva home con listas abiertas/cerradas; "Nueva lista" ligada a `route_code` del login.
5. **Bloqueo al cerrar**: solo lectura + exportar/reenviar una vez cerrada.
6. **Vista Corporativo**: ver todas las rutas, exportar consolidado, cerrar lista ajena.
7. **Offline-first sync**: cola local + reintentos, indicador de sincronización.

## Siguiente paso sugerido

Empezar por la Fase 1 (Supabase + login + roles) ya que todo lo demás depende de tener usuarios y roles funcionando primero.
