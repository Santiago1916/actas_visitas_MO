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

function normalizeSupabaseUrl(value, sourceName) {
  const raw = String(value || "").trim();
  if (!raw) {
    const error = new Error(`Missing ${sourceName}`);
    error.code = "SUPABASE_NOT_CONFIGURED";
    throw error;
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return parsed.origin;
    } catch {
      const error = new Error(`Invalid ${sourceName}: expected a valid URL, received "${raw}"`);
      error.code = "SUPABASE_NOT_CONFIGURED";
      throw error;
    }
  }

  if (/^[a-z0-9-]+\.supabase\.co$/i.test(raw)) {
    return `https://${raw}`;
  }

  if (/^[a-z0-9-]+$/i.test(raw)) {
    return `https://${raw}.supabase.co`;
  }

  const error = new Error(
    `Invalid ${sourceName}: expected project id (e.g. "abc123") or URL, received "${raw}"`
  );
  error.code = "SUPABASE_NOT_CONFIGURED";
  throw error;
}

function getSupabaseUrl() {
  const explicitUrl = process.env.SUPABASE_URL;
  if (explicitUrl) return normalizeSupabaseUrl(explicitUrl, "SUPABASE_URL");

  const projectId = process.env.SUPABASE_PROJECT_ID;
  if (!projectId) {
    const error = new Error("Missing SUPABASE_URL or SUPABASE_PROJECT_ID");
    error.code = "SUPABASE_NOT_CONFIGURED";
    throw error;
  }

  return normalizeSupabaseUrl(projectId, "SUPABASE_PROJECT_ID");
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

function formatSupabaseError(prefix, error) {
  const base = String(error?.message || error || "unknown error");
  const cause = error?.cause?.message || error?.details || null;
  const message = cause ? `${prefix}: ${base} | cause: ${cause}` : `${prefix}: ${base}`;
  const wrapped = new Error(message);
  wrapped.details = {
    message: base,
    cause: cause || null,
  };
  return wrapped;
}

export async function readGoogleOAuthTokenFromSupabase() {
  const supabase = getSupabaseClient();
  let data;
  let error;
  try {
    const response = await supabase
      .from(OAUTH_TOKEN_TABLE)
      .select("token_json")
      .eq("token_key", OAUTH_TOKEN_KEY)
      .maybeSingle();
    data = response.data;
    error = response.error;
  } catch (fetchError) {
    const dbError = formatSupabaseError("Supabase oauth token read failed", fetchError);
    dbError.code = "SUPABASE_OAUTH_TOKEN_READ_FAILED";
    throw dbError;
  }

  if (error) {
    const dbError = formatSupabaseError("Supabase oauth token read failed", error);
    dbError.code = "SUPABASE_OAUTH_TOKEN_READ_FAILED";
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

  let error;
  try {
    const response = await supabase
      .from(OAUTH_TOKEN_TABLE)
      .upsert(payload, { onConflict: "token_key" });
    error = response.error;
  } catch (fetchError) {
    const dbError = formatSupabaseError("Supabase oauth token save failed", fetchError);
    dbError.code = "SUPABASE_OAUTH_TOKEN_SAVE_FAILED";
    throw dbError;
  }

  if (error) {
    const dbError = formatSupabaseError("Supabase oauth token save failed", error);
    dbError.code = "SUPABASE_OAUTH_TOKEN_SAVE_FAILED";
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
    encargado_empresa_nombre: nullable(fields.encargadoEmpresaNombre),
    acepta_condiciones_datos: Boolean(fields.aceptaCondicionesDatos),
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

  let data;
  let error;
  try {
    const response = await supabase
      .from("actas_visita")
      .insert(payload)
      .select("id, acta_code, fecha, created_at")
      .single();
    data = response.data;
    error = response.error;
  } catch (fetchError) {
    const dbError = formatSupabaseError("Supabase insert failed", fetchError);
    dbError.code = "SUPABASE_INSERT_FAILED";
    throw dbError;
  }

  if (error) {
    const dbError = formatSupabaseError("Supabase insert failed", error);
    dbError.code = "SUPABASE_INSERT_FAILED";
    throw dbError;
  }

  return data;
}
