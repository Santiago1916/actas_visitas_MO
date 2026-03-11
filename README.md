# Actas de Visita - Mundo Ocupacional

Proyecto full-stack para diligenciar actas de visita con firma digital y envio automatico de PDF a Google Drive.

## Stack actual

- Frontend: Next.js (App Router) + React
- Backend: Node.js + Express
- Firma: `signature_pad`
- PDF: `jsPDF` (texto seleccionable + firmas embebidas)
- Storage: Google Drive API (OAuth2)
- Base de datos: Supabase (PostgreSQL)

## Estructura

- `frontend/`: interfaz en Next.js con tema claro/oscuro y estilo liquid glass
- `backend/`: API de carga a Drive y flujo OAuth2
- `backend/sql_actas_visita.sql`: script de tabla e indices en PostgreSQL
- `backend/sql_oauth_tokens.sql`: tabla para persistir token OAuth en entornos serverless

## 1) Configurar backend (OAuth2)

Para trabajar local, usa `backend/.env.dev` (recomendado) basado en `backend/.env.example`.

El backend carga variables en este orden:

1. `ENV_FILE` (si lo defines)
2. `backend/.env.dev`
3. `backend/.env`

Ejemplo de `backend/.env.dev`:

```env
PORT=8080
GOOGLE_DRIVE_FOLDER_ID=1SPvmVk514IIZXp13b0-QskDOqoyfZI7B
GOOGLE_OAUTH_CLIENT_ID=TU_CLIENT_ID.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=TU_CLIENT_SECRET
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8080/api/auth/google/callback
GOOGLE_OAUTH_TOKEN_STORE=supabase
GOOGLE_OAUTH_TOKEN_TABLE=oauth_tokens
GOOGLE_OAUTH_TOKEN_KEY=google_drive_oauth
SUPABASE_PROJECT_ID=ogzyikarmzoknjzidlut
SUPABASE_SECRET_KEY=TU_SUPABASE_SECRET_KEY
```

## 2) Crear tabla en Supabase

1. Abre el SQL Editor de Supabase para tu proyecto.
2. Ejecuta el contenido de:
   - `backend/sql_actas_visita.sql`
   - `backend/sql_oauth_tokens.sql`
   - Si ya tienes la tabla creada: `backend/sql_migration_add_compromisos_observaciones.sql`

Esto crea la tabla `public.actas_visita`, indices y trigger de `updated_at`.

## 3) Configurar frontend

```bash
cd frontend
cp .env.local.example .env.local
```

`frontend/.env.local` debe apuntar al backend:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:8080
```

Para produccion en Vercel, configura variables desde el panel de Vercel (no subas archivos `.env` al repo).

## 4) Instalar dependencias

```bash
cd backend && npm install
cd ../frontend && npm install
```

## 5) Ejecutar en desarrollo

Terminal 1:

```bash
cd backend
npm run dev
```

Terminal 2:

```bash
cd frontend
npm run dev
```

Abre:

- Frontend: `http://localhost:3000`
- Backend health: `http://localhost:8080/api/health`

## 6) Autorizar Google una sola vez

1. Abre `http://localhost:8080/api/auth/google/connect`
2. Inicia sesion y concede permisos
3. Verifica estado en `http://localhost:8080/api/auth/google/status`

Debe mostrar:

- `oauthConfigured: true`
- `oauthAuthorized: true`

## Funcionalidades

- Formulario completo del acta
- Campos separados para `Temas tratados`, `Compromisos` y `Observaciones`
- Validacion robusta de formulario con `zod` (frontend y backend)
- Tema claro/oscuro persistente
- Interfaz moderna estilo liquid glass
- Firma digital para asesor SST y responsable
- Captura de ubicacion al enviar PDF (con reintento de permiso si el usuario cancela)
- Guardar borrador en `localStorage`
- Guardar PDF
- PDF generado con texto seleccionable
- PDF con latitud/longitud y enlace a Google Maps
- Enviar PDF a Google Drive con un click
- Carpetas automaticas en Drive por fecha del acta: `YYYY / MM-Mes / Semana-N`
- Nombre de archivo con ID unico de acta para evitar colisiones
- Persistencia de datos del acta en Supabase (sin guardar binario PDF)
- Idempotencia para evitar duplicados por doble clic/reintentos (`Idempotency-Key`)
- Logs estructurados y auditoria basica en `GET /api/audit`
