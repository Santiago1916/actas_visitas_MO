import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import {
  completeGoogleOAuth,
  getGoogleOAuthUrl,
  hasStoredOAuthToken,
  isOAuthConfigured,
  uploadPdfToDrive,
} from "./driveService.js";
import { insertActaVisitRecord } from "./supabaseService.js";
import { validateUploadPayload } from "./validation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadBackendEnv() {
  const backendRoot = path.resolve(__dirname, "..");
  const resolveFromRoot = (inputPath) =>
    path.isAbsolute(inputPath) ? inputPath : path.resolve(backendRoot, inputPath);

  const candidates = [process.env.ENV_FILE, ".env.dev", ".env"]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => resolveFromRoot(value.trim()));

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    dotenv.config({ path: candidate });
    return;
  }

  dotenv.config();
}

loadBackendEnv();

const app = express();
const port = Number(process.env.PORT || 8080);

const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS || 10 * 60 * 1000);
const MAX_AUDIT_EVENTS = Number(process.env.MAX_AUDIT_EVENTS || 500);
const idempotencyStore = new Map();
const auditEvents = [];

app.use(cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));

function sanitize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-_\s]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

function buildActaCode(fields = {}) {
  const datePart = (fields.fecha || new Date().toISOString().slice(0, 10)).replace(/-/g, "");
  const randomPart = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `AV-${datePart}-${randomPart}`;
}

function buildFileName(fields = {}, actaCode) {
  const date = fields.fecha || new Date().toISOString().slice(0, 10);
  const company = sanitize(fields.razonSocial || "empresa");
  const branch = sanitize(fields.sede || "sede");
  const code = sanitize(actaCode || "").slice(0, 20) || "acta";
  const baseName = `acta-${date}-${company}-${branch}-${code}`;
  return `${baseName.slice(0, 170)}.pdf`;
}

function decodePdfBase64(payload) {
  let raw = String(payload || "").trim();

  // Accept both plain base64 and data URI variants from jsPDF.
  const dataUriMatch = raw.match(/^data:application\/pdf(?:;[^,]*)?,(.*)$/i);
  if (dataUriMatch) {
    raw = dataUriMatch[1];
  }

  if (/%[0-9a-f]{2}/i.test(raw)) {
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // Keep original string if decodeURIComponent fails.
    }
  }

  const pdfBuffer = Buffer.from(raw, "base64");
  const pdfHeader = pdfBuffer.subarray(0, 5).toString("ascii");
  if (pdfBuffer.length === 0 || pdfHeader !== "%PDF-") {
    throw new Error("Invalid PDF payload: malformed base64 or missing PDF header");
  }

  return pdfBuffer;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || null;
}

function pushAuditEvent(event) {
  auditEvents.unshift(event);
  if (auditEvents.length > MAX_AUDIT_EVENTS) {
    auditEvents.length = MAX_AUDIT_EVENTS;
  }
}

function logStructured(level, event, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data,
  };

  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }

  pushAuditEvent(entry);
  return entry;
}

function normalizeIdempotencyKey(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const safe = trimmed.replace(/[^a-zA-Z0-9._:-]/g, "");
  if (safe.length < 8) return null;
  return safe.slice(0, 120);
}

function buildAutoIdempotencyKey(fields, pdfBuffer) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(fields || {}))
    .update(pdfBuffer)
    .digest("hex");

  return `auto-${digest.slice(0, 40)}`;
}

function buildPayloadHash(fields, pdfBuffer) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(fields || {}))
    .update(pdfBuffer)
    .digest("hex");
}

function clearExpiredIdempotencyEntries() {
  const now = Date.now();
  for (const [key, entry] of idempotencyStore) {
    if (now - entry.updatedAt > IDEMPOTENCY_TTL_MS) {
      idempotencyStore.delete(key);
    }
  }
}

function getIdempotencyEntry(key) {
  clearExpiredIdempotencyEntries();
  return idempotencyStore.get(key) || null;
}

function setIdempotencyPending(key, { requestId, payloadHash }) {
  idempotencyStore.set(key, {
    status: "pending",
    requestId,
    actaCode: null,
    payloadHash,
    responseStatus: null,
    responseBody: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function setIdempotencyActaCode(key, actaCode) {
  const current = idempotencyStore.get(key);
  if (!current) return;
  current.actaCode = actaCode;
  current.updatedAt = Date.now();
  idempotencyStore.set(key, current);
}

function setIdempotencyCompleted(key, { status, responseBody, actaCode, payloadHash }) {
  idempotencyStore.set(key, {
    status: "completed",
    requestId: responseBody?.requestId || null,
    actaCode: actaCode || null,
    payloadHash,
    responseStatus: status,
    responseBody,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function clearIdempotency(key) {
  if (!key) return;
  idempotencyStore.delete(key);
}

function buildErrorPayload({
  code,
  message,
  details = null,
  issues = null,
  requestId = null,
  idempotencyKey = null,
  actaCode = null,
  authUrl = null,
}) {
  const payload = {
    ok: false,
    error: {
      code,
      message,
      details,
      issues: Array.isArray(issues) && issues.length > 0 ? issues : undefined,
    },
    details: details || message,
    requestId,
    idempotencyKey,
    actaCode,
  };

  if (authUrl) {
    payload.authUrl = authUrl;
  }

  return payload;
}

function sendApiError(res, status, options) {
  return res.status(status).json(buildErrorPayload(options));
}

setInterval(clearExpiredIdempotencyEntries, 60_000).unref();

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "actas-visitas-backend",
    idempotencyBuffered: idempotencyStore.size,
    auditBuffered: auditEvents.length,
  });
});

app.get("/api/audit", (req, res) => {
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const level = typeof req.query.level === "string" ? req.query.level.trim() : "";
  const event = typeof req.query.event === "string" ? req.query.event.trim() : "";
  const actaCode = typeof req.query.actaCode === "string" ? req.query.actaCode.trim() : "";
  const idempotencyKey =
    typeof req.query.idempotencyKey === "string" ? req.query.idempotencyKey.trim() : "";

  const items = auditEvents
    .filter((item) => {
      if (level && item.level !== level) return false;
      if (event && item.event !== event) return false;
      if (actaCode && item.actaCode !== actaCode) return false;
      if (idempotencyKey && item.idempotencyKey !== idempotencyKey) return false;
      return true;
    })
    .slice(0, limit);

  return res.json({
    ok: true,
    limit,
    count: items.length,
    totalBuffered: auditEvents.length,
    items,
  });
});

app.get("/api/auth/google/status", (_req, res) => {
  res.json({
    oauthConfigured: isOAuthConfigured(),
    oauthAuthorized: hasStoredOAuthToken(),
  });
});

app.get("/api/auth/google/url", (_req, res) => {
  if (!isOAuthConfigured()) {
    return sendApiError(res, 400, {
      code: "OAUTH_NOT_CONFIGURED",
      message: "OAuth2 no esta configurado en el backend.",
      details: "Configura GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET y GOOGLE_OAUTH_REDIRECT_URI.",
    });
  }

  return res.json({ ok: true, authUrl: getGoogleOAuthUrl() });
});

app.get("/api/auth/google/connect", (_req, res) => {
  if (!isOAuthConfigured()) {
    return res.status(400).send("OAuth2 no esta configurado en el backend.");
  }

  return res.redirect(getGoogleOAuthUrl());
});

app.get("/api/auth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code || typeof code !== "string") {
      return res.status(400).send("Falta parametro code.");
    }

    await completeGoogleOAuth(code);

    return res.send(
      "<h2>Autorizacion completada</h2><p>Ya puedes volver al formulario y usar Enviar a Drive.</p>"
    );
  } catch (error) {
    logStructured("error", "oauth.callback_error", {
      error: error?.message || "Unknown error",
    });
    return res.status(500).send(`No se pudo completar OAuth: ${error?.message || "Unknown error"}`);
  }
});

app.post("/api/drive/upload-pdf", async (req, res) => {
  const requestId = req.headers["x-request-id"]?.toString() || crypto.randomUUID();
  const clientIp = getClientIp(req);
  const userAgent = req.headers["user-agent"] || null;
  let idempotencyKey = null;
  let actaCode = null;

  try {
    const validation = validateUploadPayload(req.body || {});
    if (!validation.success) {
      logStructured("warn", "upload.validation_failed", {
        requestId,
        clientIp,
        userAgent,
        issues: validation.issues,
      });

      return sendApiError(res, 422, {
        code: "VALIDATION_ERROR",
        message: "Payload invalido para subir el acta.",
        details: "Revisa los campos requeridos e intenta de nuevo.",
        issues: validation.issues,
        requestId,
      });
    }

    const { pdfBase64, fields, location = null, idempotencyKey: bodyIdempotencyKey } = validation.data;
    const pdfBuffer = decodePdfBase64(pdfBase64);

    idempotencyKey =
      normalizeIdempotencyKey(req.headers["idempotency-key"]?.toString()) ||
      normalizeIdempotencyKey(bodyIdempotencyKey) ||
      buildAutoIdempotencyKey(fields, pdfBuffer);
    const payloadHash = buildPayloadHash(fields, pdfBuffer);

    const existing = getIdempotencyEntry(idempotencyKey);
    if (existing) {
      if (existing.payloadHash && existing.payloadHash !== payloadHash) {
        logStructured("warn", "upload.idempotency_key_reused", {
          requestId,
          idempotencyKey,
          previousActaCode: existing.actaCode,
          clientIp,
          userAgent,
        });

        return sendApiError(res, 409, {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "La llave de idempotencia ya fue usada con un payload diferente.",
          details: "Genera una nueva solicitud para continuar.",
          requestId,
          idempotencyKey,
          actaCode: existing.actaCode,
        });
      }

      if (existing.status === "pending") {
        logStructured("info", "upload.idempotency_pending", {
          requestId,
          idempotencyKey,
          actaCode: existing.actaCode,
          clientIp,
          userAgent,
        });

        return sendApiError(res, 409, {
          code: "REQUEST_IN_PROGRESS",
          message: "Ya existe una solicitud en curso para esta acta.",
          details: "Espera unos segundos y vuelve a consultar el resultado.",
          requestId,
          idempotencyKey,
          actaCode: existing.actaCode,
        });
      }

      logStructured("info", "upload.idempotency_replay", {
        requestId,
        idempotencyKey,
        actaCode: existing.actaCode,
        clientIp,
        userAgent,
      });

      return res.status(existing.responseStatus || 200).json({
        ...existing.responseBody,
        requestId,
        idempotency: {
          key: idempotencyKey,
          replayed: true,
        },
      });
    }

    setIdempotencyPending(idempotencyKey, { requestId, payloadHash });

    actaCode = buildActaCode(fields);
    setIdempotencyActaCode(idempotencyKey, actaCode);

    logStructured("info", "upload.started", {
      requestId,
      idempotencyKey,
      actaCode,
      clientIp,
      userAgent,
      fecha: fields.fecha,
      sede: fields.sede,
    });

    const driveFile = await uploadPdfToDrive({
      fileName: buildFileName(fields, actaCode),
      pdfBuffer,
      fields,
    });

    let dbRecord = null;
    let dbWarning = null;

    try {
      dbRecord = await insertActaVisitRecord({
        actaCode,
        fields,
        location,
        driveFile,
        driveFolder: driveFile.folder,
      });
    } catch (dbError) {
      dbWarning = dbError?.message || "No se pudo guardar en base de datos.";
      logStructured("warn", "upload.db_warning", {
        requestId,
        idempotencyKey,
        actaCode,
        warning: dbWarning,
      });
    }

    const responseBody = {
      ok: true,
      message: "PDF subido a Google Drive",
      requestId,
      actaCode,
      driveFile,
      driveFolder: driveFile.folder || null,
      dbRecord,
      dbWarning,
      idempotency: {
        key: idempotencyKey,
        replayed: false,
      },
    };

    setIdempotencyCompleted(idempotencyKey, {
      status: 201,
      responseBody,
      actaCode,
      payloadHash,
    });

    logStructured("info", "upload.completed", {
      requestId,
      idempotencyKey,
      actaCode,
      driveFileId: driveFile?.id || null,
      driveFileName: driveFile?.name || null,
      dbPersisted: Boolean(dbRecord),
      hasDbWarning: Boolean(dbWarning),
    });

    return res.status(201).json(responseBody);
  } catch (error) {
    clearIdempotency(idempotencyKey);

    if (error?.message?.startsWith("Invalid PDF payload")) {
      logStructured("warn", "upload.invalid_pdf", {
        requestId,
        idempotencyKey,
        actaCode,
        error: error.message,
      });

      return sendApiError(res, 400, {
        code: "INVALID_PDF_PAYLOAD",
        message: "El PDF enviado no es valido.",
        details: error.message,
        requestId,
        idempotencyKey,
        actaCode,
      });
    }

    if (error?.code === "OAUTH_NOT_AUTHORIZED") {
      logStructured("warn", "upload.oauth_not_authorized", {
        requestId,
        idempotencyKey,
        actaCode,
      });

      return sendApiError(res, 401, {
        code: "OAUTH_NOT_AUTHORIZED",
        message: "Google OAuth2 no autorizado.",
        details: "Abre /api/auth/google/connect para autorizar la cuenta de Google una sola vez.",
        authUrl: isOAuthConfigured() ? getGoogleOAuthUrl() : null,
        requestId,
        idempotencyKey,
        actaCode,
      });
    }

    const quotaExceeded =
      Array.isArray(error?.errors) && error.errors.some((entry) => entry?.reason === "storageQuotaExceeded");

    if (quotaExceeded) {
      logStructured("error", "upload.storage_quota_exceeded", {
        requestId,
        idempotencyKey,
        actaCode,
        error: error?.message || "storageQuotaExceeded",
      });

      return sendApiError(res, 500, {
        code: "DRIVE_QUOTA_EXCEEDED",
        message: "La cuenta de Google no tiene cuota disponible para almacenar el PDF.",
        details:
          "Usa una carpeta dentro de Shared Drive o cambia a OAuth2 con cuenta de usuario para subir archivos.",
        requestId,
        idempotencyKey,
        actaCode,
      });
    }

    logStructured("error", "upload.failed", {
      requestId,
      idempotencyKey,
      actaCode,
      error: error?.message || "Unknown error",
    });

    return sendApiError(res, 500, {
      code: "DRIVE_UPLOAD_FAILED",
      message: "No se pudo subir el PDF a Google Drive.",
      details: error?.message || "Unknown error",
      requestId,
      idempotencyKey,
      actaCode,
    });
  }
});

app.listen(port, () => {
  logStructured("info", "server.started", {
    port,
    url: `http://localhost:${port}`,
  });
});
