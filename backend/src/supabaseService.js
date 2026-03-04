import { createClient } from "@supabase/supabase-js";

let cachedClient = null;
const OAUTH_TOKEN_TABLE = process.env.GOOGLE_OAUTH_TOKEN_TABLE || "oauth_tokens";
const OAUTH_TOKEN_KEY = process.env.GOOGLE_OAUTH_TOKEN_KEY || "google_drive_oauth";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`Missing environment variable: ${name}`);
    error.code = "SUPABASE_NOT_CONFIGURED";
    throw error;
  }
  return value;
}

function getSupabaseUrl() {
  const explicitUrl = process.env.SUPABASE_URL;
  if (explicitUrl) return explicitUrl;

  const projectId = process.env.SUPABASE_PROJECT_ID;
  if (!projectId) {
    const error = new Error("Missing SUPABASE_URL or SUPABASE_PROJECT_ID");
    error.code = "SUPABASE_NOT_CONFIGURED";
    throw error;
  }

  return `https://${projectId}.supabase.co`;
}

function getSupabaseKey() {
  return (
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    requiredEnv("SUPABASE_SECRET_KEY")
  );
}

function getSupabaseClient() {
  if (cachedClient) return cachedClient;

  cachedClient = createClient(getSupabaseUrl(), getSupabaseKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return cachedClient;
}

function nullable(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function numberOrNull(value, decimals = null) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (typeof decimals === "number") return Number(num.toFixed(decimals));
  return num;
}

function normalizeTokenObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

export async function readGoogleOAuthTokenFromSupabase() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(OAUTH_TOKEN_TABLE)
    .select("token_json")
    .eq("token_key", OAUTH_TOKEN_KEY)
    .maybeSingle();

  if (error) {
    const dbError = new Error(`Supabase oauth token read failed: ${error.message}`);
    dbError.code = "SUPABASE_OAUTH_TOKEN_READ_FAILED";
    dbError.details = error;
    throw dbError;
  }

  return normalizeTokenObject(data?.token_json);
}

export async function saveGoogleOAuthTokenToSupabase(tokens) {
  const tokenPayload = normalizeTokenObject(tokens);
  if (!tokenPayload) {
    const invalidError = new Error("OAuth token payload is invalid.");
    invalidError.code = "OAUTH_TOKEN_INVALID_PAYLOAD";
    throw invalidError;
  }

  const supabase = getSupabaseClient();
  const payload = {
    token_key: OAUTH_TOKEN_KEY,
    token_json: tokenPayload,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from(OAUTH_TOKEN_TABLE)
    .upsert(payload, { onConflict: "token_key" });

  if (error) {
    const dbError = new Error(`Supabase oauth token save failed: ${error.message}`);
    dbError.code = "SUPABASE_OAUTH_TOKEN_SAVE_FAILED";
    dbError.details = error;
    throw dbError;
  }
}

export async function insertActaVisitRecord({
  actaCode,
  fields = {},
  location = null,
  driveFile = null,
  driveFolder = null,
}) {
  const supabase = getSupabaseClient();

  const payload = {
    acta_code: nullable(actaCode),
    fecha: nullable(fields.fecha),
    razon_social: nullable(fields.razonSocial),
    sede: nullable(fields.sede),
    hora_inicio: nullable(fields.horaInicio),
    hora_fin: nullable(fields.horaFin),
    contacto_empresa: nullable(fields.contacto),
    telefono: nullable(fields.telefono),
    email: nullable(fields.email),
    participantes: nullable(fields.participantes),
    temas_tratados: nullable(fields.temasTratados),
    compromisos: nullable(fields.compromisos),
    observaciones: nullable(fields.observaciones),
    latitud: numberOrNull(location?.lat, 8),
    longitud: numberOrNull(location?.lng, 8),
    ubicacion_capturada_at: nullable(location?.capturedAt),
    drive_file_id: nullable(driveFile?.id),
    drive_file_name: nullable(driveFile?.name),
    drive_web_view_link: nullable(driveFile?.webViewLink),
    drive_web_content_link: nullable(driveFile?.webContentLink),
    drive_year_folder: nullable(driveFolder?.yearName),
    drive_month_folder: nullable(driveFolder?.monthName),
    drive_week_folder: nullable(driveFolder?.weekName),
    drive_week_of_month: numberOrNull(driveFolder?.weekOfMonth),
  };

  const { data, error } = await supabase
    .from("actas_visita")
    .insert(payload)
    .select("id, acta_code, fecha, created_at")
    .single();

  if (error) {
    const dbError = new Error(`Supabase insert failed: ${error.message}`);
    dbError.code = "SUPABASE_INSERT_FAILED";
    dbError.details = error;
    throw dbError;
  }

  return data;
}
