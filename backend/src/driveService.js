import { google } from "googleapis";
import { Readable } from "stream";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const MONTHS_ES = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function resolveOAuthTokenPath() {
  return process.env.GOOGLE_OAUTH_TOKEN_PATH || path.resolve(__dirname, "../oauth-token.json");
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getOAuthConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) return null;

  return {
    clientId,
    clientSecret,
    redirectUri,
  };
}

function parseActaDate(fechaInput) {
  if (typeof fechaInput === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fechaInput)) {
    const [year, month, day] = fechaInput.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  if (!fechaInput) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  const parsed = new Date(fechaInput);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid fecha value: ${fechaInput}`);
  }

  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function getWeekOfMonth(date) {
  // Week buckets by day range: 1-7 => Semana-1, 8-14 => Semana-2, etc.
  return Math.ceil(date.getDate() / 7);
}

function buildMonthFolderName(date) {
  const month = date.getMonth();
  return `${String(month + 1).padStart(2, "0")}-${MONTHS_ES[month]}`;
}

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function isOAuthConfigured() {
  return Boolean(getOAuthConfig());
}

export function hasStoredOAuthToken() {
  const token = safeReadJson(resolveOAuthTokenPath());
  return Boolean(token?.refresh_token);
}

function buildOAuthClient() {
  const config = getOAuthConfig();
  if (!config) {
    throw new Error(
      "OAuth config missing: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI"
    );
  }

  return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
}

function readStoredOAuthToken() {
  return safeReadJson(resolveOAuthTokenPath());
}

function saveOAuthToken(tokens) {
  const tokenPath = resolveOAuthTokenPath();
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
}

export function getGoogleOAuthUrl() {
  const oauthClient = buildOAuthClient();

  return oauthClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: DRIVE_SCOPES,
  });
}

export async function completeGoogleOAuth(code) {
  const oauthClient = buildOAuthClient();
  const { tokens } = await oauthClient.getToken(code);
  const existing = readStoredOAuthToken() || {};
  const merged = { ...existing, ...tokens };

  if (!merged.refresh_token) {
    throw new Error("OAuth token does not include refresh_token. Re-authorize with prompt=consent.");
  }

  saveOAuthToken(merged);
  return merged;
}

function getCredentialsFromFileIfAvailable() {
  const jsonPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;
  if (!jsonPath) return null;
  const raw = fs.readFileSync(jsonPath, "utf8");
  const parsed = JSON.parse(raw);
  return {
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key,
  };
}

function buildServiceAccountAuth() {
  const fileCreds = getCredentialsFromFileIfAvailable();
  const clientEmail = fileCreds?.clientEmail || requiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const rawPrivateKey = fileCreds?.privateKey || requiredEnv("GOOGLE_PRIVATE_KEY");
  const privateKey = String(rawPrivateKey)
    .trim()
    .replace(/^"(.*)"$/s, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\r/g, "");

  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: DRIVE_SCOPES,
  });
}

function buildOAuthAuthOrThrow() {
  const oauthClient = buildOAuthClient();
  const token = readStoredOAuthToken();

  if (!token?.refresh_token) {
    const error = new Error("OAuth authorization required");
    error.code = "OAUTH_NOT_AUTHORIZED";
    throw error;
  }

  oauthClient.setCredentials(token);
  return oauthClient;
}

function buildDriveClient() {
  if (isOAuthConfigured()) {
    return google.drive({ version: "v3", auth: buildOAuthAuthOrThrow() });
  }

  return google.drive({ version: "v3", auth: buildServiceAccountAuth() });
}

async function ensureFolderExists({ drive, parentId, folderName }) {
  const escapedName = escapeDriveQuery(folderName);
  const query = `mimeType='${DRIVE_FOLDER_MIME}' and trashed=false and name='${escapedName}' and '${parentId}' in parents`;

  const listed = await drive.files.list({
    q: query,
    pageSize: 1,
    fields: "files(id,name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const existing = listed.data.files?.[0];
  if (existing?.id) return existing;

  const created = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: folderName,
      mimeType: DRIVE_FOLDER_MIME,
      parents: [parentId],
    },
    fields: "id,name",
  });

  return created.data;
}

async function resolveFolderByFecha({ drive, rootFolderId, fecha }) {
  const actaDate = parseActaDate(fecha);
  const yearName = String(actaDate.getFullYear());
  const monthName = buildMonthFolderName(actaDate);
  const weekOfMonth = getWeekOfMonth(actaDate);
  const weekName = `Semana-${weekOfMonth}`;

  const yearFolder = await ensureFolderExists({
    drive,
    parentId: rootFolderId,
    folderName: yearName,
  });

  const monthFolder = await ensureFolderExists({
    drive,
    parentId: yearFolder.id,
    folderName: monthName,
  });

  const weekFolder = await ensureFolderExists({
    drive,
    parentId: monthFolder.id,
    folderName: weekName,
  });

  return {
    rootFolderId,
    targetFolderId: weekFolder.id,
    yearFolderId: yearFolder.id,
    monthFolderId: monthFolder.id,
    weekFolderId: weekFolder.id,
    yearName,
    monthName,
    weekName,
    weekOfMonth,
    sourceDate: actaDate.toISOString().slice(0, 10),
  };
}

export async function uploadPdfToDrive({ fileName, pdfBuffer, fields = {} }) {
  const rootFolderId = requiredEnv("GOOGLE_DRIVE_FOLDER_ID");
  const drive = buildDriveClient();
  const folder = await resolveFolderByFecha({
    drive,
    rootFolderId,
    fecha: fields?.fecha,
  });

  const response = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: fileName,
      parents: [folder.targetFolderId],
      mimeType: "application/pdf",
    },
    media: {
      mimeType: "application/pdf",
      body: Readable.from(pdfBuffer),
    },
    fields: "id,name,webViewLink,webContentLink",
  });

  return {
    ...response.data,
    folder,
  };
}
