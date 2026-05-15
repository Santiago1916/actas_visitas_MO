"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { sileo } from "sileo";
import { DayPicker } from "react-day-picker";
import { es } from "date-fns/locale";
import SignatureField from "../components/SignatureField";
import AlarmTimeField from "../components/AlarmTimeField";

const STORAGE_KEY = "actaVisitaDraft.v4.next";
const THEME_KEY = "actaVisitaTheme.v1";
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8080";
const MAX_VERCEL_FUNCTION_PAYLOAD_BYTES = 4_300_000;
const SUPPORT_PHONE = "573113803224";
const SUPPORT_TEXT = "tengo problema con el acta de visitas mundo ocupacional";
const SUPPORT_WA_URL = `https://wa.me/${SUPPORT_PHONE}?text=${encodeURIComponent(SUPPORT_TEXT)}`;
const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BOGOTA_TIMEZONE = "America/Bogota";
const CALENDAR_MONTHS_BACK_LIMIT = 5;
const DEFAULT_ACTA_TYPE = "visitas";
const ACTA_TYPE_OPTIONS = Object.freeze([
  { value: "visitas", title: "Acta de Visitas", subtitle: "Registro de visita SST" },
  { value: "actividades", title: "Acta de Actividades", subtitle: "Registro de actividades SST" },
]);
const GEOLOCATION_PRECISE_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  timeout: 12000,
  maximumAge: 0,
});
const GEOLOCATION_FALLBACK_OPTIONS = Object.freeze({
  enableHighAccuracy: false,
  timeout: 10000,
  maximumAge: 5 * 60 * 1000,
});
const DATA_POLICY_TITLE = "ACEPTACIÓN DE LA ACTIVIDAD Y TRATAMIENTO DE DATOS";
const DATA_POLICY_EMAIL = "servicioalcliente@mundoocupacional.com";
const DATA_POLICY_WEB_URL = "https://www.mundoocupacional.com";
const DATA_POLICY_ITEMS = [
  "1. Conformidad de la visita (SST): Recibí a satisfacción las actividades ejecutadas por el asesor de MUNDO OCUPACIONAL S.A.S. Reconozco que esta firma electrónica tiene total validez legal y probatoria (Ley 527 de 1999) como evidencia de gestión para nuestro SG-SST ante el Ministerio del Trabajo y la ARL (Decreto 1072 de 2015).",
  "2. Tratamiento de Datos (Ley 1581): Autorizo a MUNDO OCUPACIONAL S.A.S. (NIT 900.520.288-1) a tratar mis datos personales aquí registrados exclusivamente para documentar esta visita y gestionar el servicio. Conozco que puedo ejercer mis derechos (conocer, actualizar o borrar mis datos) escribiendo a [EMAIL] o leyendo la política completa en [WEB].",
];

const SEND_STEPS = {
  idle: "",
  locating: "Solicitando ubicacion...",
  generating: "Generando PDF...",
  uploading: "Subiendo PDF a Drive...",
  saving: "Guardando registro...",
};

function logFrontendEvent(level, event, data = {}) {
  if (typeof console === "undefined") return;

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
    console.info(line);
  }
}

function createRequestId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `front-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getActaLogContext(fields = {}, actaType = DEFAULT_ACTA_TYPE) {
  return {
    actaType,
    fecha: fields.fecha || null,
    sede: fields.sede || null,
    razonSocialLength: String(fields.razonSocial || "").length,
  };
}

const formSchema = z
  .object({
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener formato YYYY-MM-DD."),
    razonSocial: z.string().trim().min(1, "Ingresa la razon social.").max(220, "Razon social demasiado larga."),
    sede: z.string().trim().min(1, "Ingresa la sede.").max(180, "Sede demasiado larga."),
    horaInicio: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Hora inicio invalida."),
    horaFin: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Hora fin invalida."),
    contacto: z.string().trim().min(1, "Ingresa el contacto de la empresa.").max(180, "Contacto demasiado largo."),
    encargadoEmpresaNombre: z
      .string()
      .trim()
      .min(1, "Ingresa el nombre del encargado de la empresa.")
      .max(180, "Nombre del encargado demasiado largo."),
    aceptaCondicionesDatos: z
      .boolean()
      .refine((value) => value === true, "Debes aceptar las condiciones de la visita y el tratamiento de datos."),
    telefono: z
      .string()
      .trim()
      .max(30, "Telefono demasiado largo.")
      .refine((value) => value.length === 0 || value.length >= 7, "Telefono invalido."),
    email: z
      .string()
      .trim()
      .max(180, "Email demasiado largo.")
      .refine((value) => value.length === 0 || SIMPLE_EMAIL_RE.test(value), "Email invalido."),
    participantes: z.string().trim().min(3, "Ingresa los participantes.").max(2000, "Texto demasiado largo."),
    temasTratados: z.string().trim().min(5, "Ingresa los temas tratados.").max(6000, "Texto demasiado largo."),
    compromisos: z.string().trim().min(1, "Ingresa los planes de accion.").max(4000, "Texto demasiado largo."),
    observaciones: z.string().trim().min(1, "Ingresa las observaciones.").max(4000, "Texto demasiado largo."),
  })
  .superRefine((value, ctx) => {
    if (value.horaFin < value.horaInicio) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["horaFin"],
        message: "La hora fin debe ser posterior o igual a la hora inicio.",
      });
    }
  });

const initialData = {
  fecha: "",
  razonSocial: "",
  sede: "",
  horaInicio: "",
  horaFin: "",
  contacto: "",
  encargadoEmpresaNombre: "",
  aceptaCondicionesDatos: false,
  telefono: "",
  email: "",
  participantes: "",
  temasTratados: "",
  compromisos: "",
  observaciones: "",
};

let logoDataUrlPromise = null;

function getTodayLocalFallbackISO() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getTodayBogotaISO() {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: BOGOTA_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const parts = formatter.formatToParts(new Date());
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;

    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // Ignore and use local fallback.
  }

  return getTodayLocalFallbackISO();
}

function formatCoordinate(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  return value.toFixed(6);
}

function parseISODate(value) {
  if (!value || typeof value !== "string") return undefined;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

function formatAsISODate(value) {
  const yyyy = value.getFullYear();
  const mm = String(value.getMonth() + 1).padStart(2, "0");
  const dd = String(value.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function subtractMonthsClamped(baseDate, months) {
  const year = baseDate.getFullYear();
  const monthIndex = baseDate.getMonth() - months;
  const day = baseDate.getDate();
  const maxDayInTargetMonth = new Date(year, monthIndex + 1, 0).getDate();
  const safeDay = Math.min(day, maxDayInTargetMonth);
  return new Date(year, monthIndex, safeDay);
}

function clampDateToRange(targetDate, minDate, maxDate) {
  const normalizedTarget = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  const normalizedMin = new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate());
  const normalizedMax = new Date(maxDate.getFullYear(), maxDate.getMonth(), maxDate.getDate());

  if (normalizedTarget < normalizedMin) return normalizedMin;
  if (normalizedTarget > normalizedMax) return normalizedMax;
  return normalizedTarget;
}

function buildGoogleMapsUrl(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

function base64ToBytes(base64 = "") {
  const clean = String(base64).replace(/\s/g, "");
  if (!clean) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

function downloadPdfFromBase64(pdfBase64, preferredName = "acta-visita.pdf") {
  if (!pdfBase64 || typeof window === "undefined") return;

  const cleanBase64 = String(pdfBase64).replace(/\s/g, "");
  const fileName = String(preferredName || "acta-visita.pdf").trim() || "acta-visita.pdf";
  const normalizedFileName = fileName.toLowerCase().endsWith(".pdf") ? fileName : `${fileName}.pdf`;

  const binary = window.atob(cleanBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const blob = new Blob([bytes], { type: "application/pdf" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = normalizedFileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

function requestBrowserLocation(options = GEOLOCATION_PRECISE_OPTIONS) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Este navegador no soporta geolocalizacion."));
      return;
    }

    if (typeof window !== "undefined" && window.isSecureContext === false) {
      reject(new Error("La geolocalizacion requiere HTTPS o localhost."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position),
      (error) => reject(error),
      options
    );
  });
}

async function getLogoDataUrl() {
  if (logoDataUrlPromise) return logoDataUrlPromise;

  logoDataUrlPromise = new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => reject(new Error("No se pudo cargar el logo para el PDF."));
    image.src = "/img/logo-claro.png";
  });

  return logoDataUrlPromise;
}

async function optimizeSignatureDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return "";
  if (typeof window === "undefined") return dataUrl;

  try {
    const optimized = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const maxWidth = 900;
        const maxHeight = 260;
        const scale = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight, 1);
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);

        // Force dark ink in the PDF while preserving anti-aliasing alpha.
        const imageData = ctx.getImageData(0, 0, width, height);
        const pixels = imageData.data;
        for (let index = 0; index < pixels.length; index += 4) {
          const alpha = pixels[index + 3];
          if (alpha === 0) continue;
          pixels[index] = 0;
          pixels[index + 1] = 0;
          pixels[index + 2] = 0;
        }
        ctx.putImageData(imageData, 0, 0);

        resolve(canvas.toDataURL("image/png"));
      };
      image.onerror = () => reject(new Error("No se pudo optimizar la firma."));
      image.src = dataUrl;
    });

    if (typeof optimized === "string" && optimized.length > 0 && optimized.length < dataUrl.length) {
      return optimized;
    }
    return dataUrl;
  } catch {
    return dataUrl;
  }
}

function buildFieldErrors(issues = []) {
  const next = {};
  for (const issue of issues) {
    const key = issue.path?.[0];
    if (!key || next[key]) continue;
    next[key] = issue.message;
  }
  return next;
}

function resolveApiErrorMessage(payload, fallback) {
  if (payload?.error?.message && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  if (payload?.error && typeof payload.error === "string") {
    return payload.error;
  }
  if (payload?.details && typeof payload.details === "string") {
    return payload.details;
  }
  return fallback;
}

function buildApiErrorDescription(payload, fallback) {
  const message = resolveApiErrorMessage(payload, fallback);
  const requestId = payload?.requestId;
  const code = payload?.error?.code;
  const suffix = [code ? `Codigo: ${code}` : "", requestId ? `Soporte: ${requestId}` : ""]
    .filter(Boolean)
    .join(" | ");

  return suffix ? `${message} (${suffix})` : message;
}

function resolveReadinessIssue(checks = {}) {
  if (checks.oauth && !checks.oauth.ok) {
    return {
      title: "Google Drive sin autorizacion",
      description: checks.oauth.message || "Autoriza Google Drive antes de enviar el acta.",
      authUrl: checks.oauth.authUrl || null,
      code: "OAUTH_NOT_READY",
    };
  }

  if (checks.drive && !checks.drive.ok) {
    return {
      title: "Drive no disponible",
      description: checks.drive.message || "No se pudo validar la carpeta destino de Google Drive.",
      code: "DRIVE_NOT_READY",
    };
  }

  if (checks.supabase && !checks.supabase.ok) {
    return {
      title: "Base de datos no disponible",
      description: checks.supabase.message || "No se pudo validar la tabla actas_visita en Supabase.",
      code: "SUPABASE_NOT_READY",
    };
  }

  return {
    title: "Servicio no disponible",
    description: "No se pudo validar el estado del backend.",
    code: "UPLOAD_NOT_READY",
  };
}

async function sha256Hex(text) {
  if (window.crypto?.subtle) {
    const buffer = new TextEncoder().encode(text);
    const digest = await window.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  // Minimal fallback when SubtleCrypto is unavailable.
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return `${Math.abs(hash)}`;
}

async function buildActaContentKey({ fields, actaType, firmaAsesor, firmaResponsable }) {
  const seed = JSON.stringify({
    fields,
    firmaAsesor,
    firmaResponsable,
    actaType: actaType || DEFAULT_ACTA_TYPE,
  });

  const digest = await sha256Hex(seed);
  return `acta-content-${digest}`;
}

async function buildIdempotencyKey({ fields, actaType, firmaAsesor, firmaResponsable, location, pdfBase64 }) {
  const pdfHash = pdfBase64 ? await sha256Hex(pdfBase64) : "";
  const seed = JSON.stringify({
    fields,
    firmaAsesor,
    firmaResponsable,
    actaType: actaType || DEFAULT_ACTA_TYPE,
    location,
    pdfHash,
  });

  const digest = await sha256Hex(seed);
  return `acta-${digest.slice(0, 40)}`;
}

export default function Page() {
  const [formData, setFormData] = useState({ ...initialData, fecha: getTodayBogotaISO() });
  const [actaType, setActaType] = useState(DEFAULT_ACTA_TYPE);
  const [errors, setErrors] = useState({});
  const [isSending, setIsSending] = useState(false);
  const [sendStep, setSendStep] = useState("idle");
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [isDataPolicyModalOpen, setIsDataPolicyModalOpen] = useState(false);
  const [theme, setTheme] = useState("light");
  const [isThemeHydrated, setIsThemeHydrated] = useState(false);
  const asesorRef = useRef(null);
  const responsableRef = useRef(null);
  const calendarRef = useRef(null);
  const hasShownWelcomeRef = useRef(false);
  const lastSuccessfulUploadRef = useRef(null);

  const sendStepLabel = useMemo(() => SEND_STEPS[sendStep] || "Procesando...", [sendStep]);
  const maxCalendarDate = useMemo(() => parseISODate(getTodayBogotaISO()) || new Date(), []);
  const minCalendarDate = useMemo(
    () => subtractMonthsClamped(maxCalendarDate, CALENDAR_MONTHS_BACK_LIMIT),
    [maxCalendarDate]
  );
  const dayPickerDisabledMatchers = useMemo(() => {
    const matchers = [{ before: minCalendarDate }, { after: maxCalendarDate }];
    if (isSending) {
      matchers.push(() => true);
    }
    return matchers;
  }, [minCalendarDate, maxCalendarDate, isSending]);
  const actaHeader = useMemo(
    () => ACTA_TYPE_OPTIONS.find((option) => option.value === actaType) || ACTA_TYPE_OPTIONS[0],
    [actaType]
  );

  useEffect(() => {
    let nextTheme = "light";
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme === "light" || savedTheme === "dark") {
      nextTheme = savedTheme;
    } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      nextTheme = "dark";
    }

    setTheme(nextTheme);
    setIsThemeHydrated(true);
  }, []);

  useEffect(() => {
    if (!isThemeHydrated) return;
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme, isThemeHydrated]);

  useEffect(() => {
    if (!isThemeHydrated || hasShownWelcomeRef.current) return;
    hasShownWelcomeRef.current = true;
    sileo.info({
      title: "Bienvenido",
      description: "Bienvenido al formulario de actas de visita de Mundo Ocupacional.",
    });
  }, [isThemeHydrated]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (!isCalendarOpen) return;
      if (calendarRef.current?.contains(event.target)) return;
      setIsCalendarOpen(false);
    }

    function handleEsc(event) {
      if (event.key === "Escape") {
        if (isDataPolicyModalOpen) {
          setIsDataPolicyModalOpen(false);
          return;
        }
        setIsCalendarOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [isCalendarOpen, isDataPolicyModalOpen]);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    try {
      const draft = JSON.parse(raw);
      if (draft.fields) {
        setFormData((prev) => {
          const next = { ...prev, ...draft.fields };
          const parsedDraftDate = parseISODate(next.fecha);
          const safeDate = parsedDraftDate
            ? clampDateToRange(parsedDraftDate, minCalendarDate, maxCalendarDate)
            : maxCalendarDate;

          return {
            ...next,
            fecha: formatAsISODate(safeDate),
          };
        });
      }
      if (draft.actaType && ACTA_TYPE_OPTIONS.some((option) => option.value === draft.actaType)) {
        setActaType(draft.actaType);
      }

      setTimeout(() => {
        asesorRef.current?.fromDataURL(draft.firmaAsesor || "");
        responsableRef.current?.fromDataURL(draft.firmaResponsable || "");
      }, 40);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [maxCalendarDate, minCalendarDate]);

  function clearFieldError(name) {
    setErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  function onFieldChange(event) {
    const { name, type, value, checked } = event.target;
    const nextValue = type === "checkbox" ? checked : value;
    setFormData((prev) => ({ ...prev, [name]: nextValue }));
    clearFieldError(name);

    if (name === "horaInicio" || name === "horaFin") {
      clearFieldError("horaInicio");
      clearFieldError("horaFin");
    }
  }

  function handleDateSelect(day) {
    if (!day) return;
    const boundedDay = clampDateToRange(day, minCalendarDate, maxCalendarDate);
    const nextDate = formatAsISODate(boundedDay);
    setFormData((prev) => ({ ...prev, fecha: nextDate }));
    clearFieldError("fecha");
    setIsCalendarOpen(false);
  }

  function onTimeFieldChange(name, value) {
    setFormData((prev) => ({ ...prev, [name]: value }));
    clearFieldError(name);
    clearFieldError("horaInicio");
    clearFieldError("horaFin");
  }

  function validateFormDataWithSchema() {
    const result = formSchema.safeParse(formData);
    if (result.success) {
      setErrors({});
      return true;
    }

    const nextErrors = buildFieldErrors(result.error.issues);
    setErrors(nextErrors);
    logFrontendEvent("warn", "acta.validation_failed", {
      ...getActaLogContext(formData, actaType),
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    sileo.warning({
      title: "Formulario incompleto",
      description: "Revisa los campos marcados antes de continuar.",
    });
    return false;
  }

  function validateSignatures() {
    const asesorEmpty = asesorRef.current?.isEmpty() ?? true;
    const responsableEmpty = responsableRef.current?.isEmpty() ?? true;

    if (asesorEmpty || responsableEmpty) {
      logFrontendEvent("warn", "acta.signatures_missing", {
        ...getActaLogContext(formData, actaType),
        asesorEmpty,
        responsableEmpty,
      });
      sileo.warning({
        title: "Firmas incompletas",
        description: "Debes registrar ambas firmas antes de continuar.",
      });
      return false;
    }

    return true;
  }

  function collectPayload() {
    return {
      fields: formData,
      actaType,
      firmaAsesor: asesorRef.current?.toDataURL() || "",
      firmaResponsable: responsableRef.current?.toDataURL() || "",
    };
  }

  function handleSaveDraft() {
    if (isSending) return;

    localStorage.setItem(STORAGE_KEY, JSON.stringify(collectPayload()));
    sileo.success({
      title: "Borrador guardado",
      description: "El formulario y las firmas se guardaron en este navegador.",
    });
  }

  function handleReset() {
    if (isSending) return;

    setFormData({
      ...initialData,
      fecha: getTodayBogotaISO(),
    });
    setActaType(DEFAULT_ACTA_TYPE);
    setErrors({});
    setIsDataPolicyModalOpen(false);
    asesorRef.current?.clear();
    responsableRef.current?.clear();
    lastSuccessfulUploadRef.current = null;
    localStorage.removeItem(STORAGE_KEY);
  }

  async function copyDataPolicyEmail() {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(DATA_POLICY_EMAIL);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = DATA_POLICY_EMAIL;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }

      sileo.success({
        title: "Correo copiado",
        description: `Se copió ${DATA_POLICY_EMAIL} al portapapeles.`,
      });
    } catch {
      sileo.warning({
        title: "No se pudo copiar",
        description: `Copia manualmente el correo: ${DATA_POLICY_EMAIL}`,
      });
    }
  }

  async function captureLocationWithRetry() {
    const mapPosition = (position) => ({
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      capturedAt: new Date().toISOString(),
    });

    const tryCapture = async () => {
      try {
        const precisePosition = await requestBrowserLocation(GEOLOCATION_PRECISE_OPTIONS);
        return mapPosition(precisePosition);
      } catch (error) {
        if (error?.code === 1) {
          logFrontendEvent("warn", "acta.location_permission_denied", {
            ...getActaLogContext(formData, actaType),
            phase: "locating",
          });
          throw error;
        }

        if (error?.code === 2 || error?.code === 3) {
          logFrontendEvent("warn", "acta.location_precise_failed", {
            ...getActaLogContext(formData, actaType),
            phase: "locating",
            geolocationCode: error.code,
            message: error.message || null,
          });
          sileo.info({
            title: "Reintentando ubicacion",
            description: "El GPS tardo mas de lo esperado. Intentando con una ubicacion aproximada del dispositivo.",
          });

          const fallbackPosition = await requestBrowserLocation(GEOLOCATION_FALLBACK_OPTIONS);
          return mapPosition(fallbackPosition);
        }

        throw error;
      }
    };

    try {
      return await tryCapture();
    } catch (error) {
      if (error?.code === 1) {
        const retry = window.confirm(
          "Debes permitir la ubicacion para enviar el PDF. Deseas volver a intentarlo ahora?"
        );
        if (retry) {
          try {
            return await tryCapture();
          } catch {
            throw new Error("No se obtuvo ubicacion. Habilita el permiso de ubicacion y vuelve a intentar.");
          }
        }
        throw new Error("Permiso de ubicacion cancelado por el usuario.");
      }

      if (error?.code === 2) {
        logFrontendEvent("error", "acta.location_unavailable", {
          ...getActaLogContext(formData, actaType),
          phase: "locating",
          geolocationCode: error.code,
          message: error.message || null,
        });
        throw new Error("No se pudo determinar la ubicacion actual.");
      }
      if (error?.code === 3) {
        logFrontendEvent("error", "acta.location_timeout", {
          ...getActaLogContext(formData, actaType),
          phase: "locating",
          geolocationCode: error.code,
          message: error.message || null,
        });
        throw new Error("Tiempo agotado al solicitar ubicacion. Intenta activar GPS, datos moviles o Wi-Fi y vuelve a intentarlo.");
      }
      logFrontendEvent("error", "acta.location_failed", {
        ...getActaLogContext(formData, actaType),
        phase: "locating",
        message: error?.message || "Error obteniendo la ubicacion.",
      });
      throw new Error(error?.message || "Error obteniendo la ubicacion.");
    }
  }

  async function assertUploadReadiness(baseLogContext) {
    const response = await fetch(`${API_BASE}/api/diagnostics/upload-readiness`, {
      method: "GET",
      headers: {
        "X-Request-Id": baseLogContext.requestId,
      },
    });
    const payload = await response.json().catch(() => ({}));

    if (response.ok && payload?.ok) {
      logFrontendEvent("info", "acta.upload_readiness_ok", {
        ...baseLogContext,
        backendRequestId: payload.requestId || null,
      });
      return;
    }

    const issue = resolveReadinessIssue(payload?.checks);
    logFrontendEvent("error", "acta.upload_readiness_failed", {
      ...baseLogContext,
      status: response.status,
      backendRequestId: payload?.requestId || null,
      code: issue.code,
      checks: payload?.checks || null,
    });

    if (issue.authUrl) {
      const authWindow = window.open(issue.authUrl, "_blank", "noopener,noreferrer");
      if (!authWindow) {
        sileo.info({
          title: "Ventana bloqueada",
          description: "Habilita pop-ups para completar la autorizacion de Google.",
        });
      }
    }

    const requestHint = payload?.requestId ? ` Soporte: ${payload.requestId}` : "";
    const error = new Error(`${issue.description}${requestHint}`);
    error.title = issue.title;
    throw error;
  }

  async function buildPdfBase64(locationData) {
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ orientation: "p", unit: "mm", format: "a4", compress: true });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 14;
    const bottomLimit = pageHeight - 14;
    const contentWidth = pageWidth - margin * 2;
    const colGap = 6;
    const colWidth = (contentWidth - colGap) / 2;
    let y = 14;

    const normalize = (value) => {
      const text = String(value ?? "").trim();
      return text || "-";
    };

    const splitByWidth = (value, width) => {
      return doc.splitTextToSize(normalize(value).replace(/\r\n/g, "\n"), width);
    };

    const ensureSpace = (requiredHeight) => {
      if (y + requiredHeight > bottomLimit) {
        doc.addPage();
        y = 14;
      }
    };

    const drawTwoColumnRow = (leftLabel, leftValue, rightLabel, rightValue) => {
      const leftLines = splitByWidth(leftValue, colWidth - 6);
      const rightLines = splitByWidth(rightValue, colWidth - 6);
      const maxLines = Math.max(leftLines.length, rightLines.length, 1);
      const rowHeight = 10 + maxLines * 4.3;
      ensureSpace(rowHeight + 2.5);

      doc.setDrawColor(190, 200, 212);
      doc.setFillColor(248, 251, 255);
      doc.roundedRect(margin, y, colWidth, rowHeight, 2, 2, "FD");
      doc.roundedRect(margin + colWidth + colGap, y, colWidth, rowHeight, 2, 2, "FD");

      doc.setFont("helvetica", "bold");
      doc.setFontSize(9.5);
      doc.text(leftLabel, margin + 3, y + 4.5);
      doc.text(rightLabel, margin + colWidth + colGap + 3, y + 4.5);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.5);
      doc.text(leftLines, margin + 3, y + 9.2);
      doc.text(rightLines, margin + colWidth + colGap + 3, y + 9.2);

      y += rowHeight + 2.5;
    };

    const drawTextSection = (title, value, minLines = 4) => {
      const lines = splitByWidth(value, contentWidth - 6);
      const totalLines = Math.max(lines.length, minLines);
      const sectionHeight = 11 + totalLines * 4.2;
      ensureSpace(sectionHeight + 3);

      doc.setDrawColor(190, 200, 212);
      doc.setFillColor(248, 251, 255);
      doc.roundedRect(margin, y, contentWidth, sectionHeight, 2, 2, "FD");

      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.text(title, margin + 3, y + 5);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.5);
      doc.text(lines, margin + 3, y + 10);

      y += sectionHeight + 3;
    };

    const logoDataUrl = await getLogoDataUrl().catch(() => "");

    doc.setDrawColor(195, 206, 222);
    doc.setFillColor(246, 249, 255);
    doc.roundedRect(margin, y, contentWidth, 24, 3, 3, "FD");
    doc.setFillColor(43, 27, 128);
    doc.rect(margin, y, contentWidth, 5, "F");

    if (logoDataUrl) {
      doc.addImage(logoDataUrl, "PNG", margin + 3, y + 7, 46, 15);
    }

    doc.setTextColor(43, 27, 128);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text(actaHeader.title, margin + 53, y + 13);
    doc.setTextColor(88, 101, 120);
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.text(actaHeader.subtitle, margin + 53, y + 18.5);
    doc.setTextColor(30, 40, 55);
    y += 28;

    drawTwoColumnRow("Fecha", formData.fecha, "Sede", formData.sede);
    drawTwoColumnRow(
      "Nombre o razon social",
      formData.razonSocial,
      "Contacto de la empresa",
      formData.contacto
    );
    drawTwoColumnRow("Hora inicio", formData.horaInicio, "Hora fin", formData.horaFin);
    drawTwoColumnRow("Telefono", formData.telefono, "Email", formData.email);

    if (locationData) {
      const capturedDate = locationData.capturedAt ? new Date(locationData.capturedAt).toLocaleString("es-CO") : "-";
      drawTwoColumnRow("Latitud", formatCoordinate(locationData.lat), "Longitud", formatCoordinate(locationData.lng));
      drawTwoColumnRow("Ubicacion capturada", capturedDate, "Referencia", "Geolocalizacion del dispositivo");
    }

    drawTextSection("Participantes", formData.participantes, 4);
    drawTextSection("Temas tratados o actividades realizadas", formData.temasTratados, 7);
    drawTextSection("Planes de accion", formData.compromisos, 5);
    drawTextSection("Observaciones", formData.observaciones, 5);

    const asesorSignatureRaw = asesorRef.current?.toDataURL() || "";
    const responsableSignatureRaw = responsableRef.current?.toDataURL() || "";
    const [asesorSignature, responsableSignature] = await Promise.all([
      optimizeSignatureDataUrl(asesorSignatureRaw),
      optimizeSignatureDataUrl(responsableSignatureRaw),
    ]);
    const signatureBoxHeight = 56;
    ensureSpace(signatureBoxHeight + 6);

    doc.setDrawColor(190, 200, 212);
    doc.roundedRect(margin, y, colWidth, signatureBoxHeight, 2, 2);
    doc.roundedRect(margin + colWidth + colGap, y, colWidth, signatureBoxHeight, 2, 2);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.4);
    doc.text("Firma del Participante (Consultor SST mundo ocupacional)", margin + 3, y + 5);
    doc.text("Firma responsable encargado de la empresa", margin + colWidth + colGap + 3, y + 5);

    if (asesorSignature) {
      doc.addImage(asesorSignature, "PNG", margin + 3, y + 8, colWidth - 6, 28);
    }
    if (responsableSignature) {
      doc.addImage(responsableSignature, "PNG", margin + colWidth + colGap + 3, y + 8, colWidth - 6, 28);
    }

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const encargadoNombreLines = splitByWidth(
      `Nombre encargado: ${normalize(formData.encargadoEmpresaNombre)}`,
      colWidth - 6
    );
    doc.text(encargadoNombreLines, margin + colWidth + colGap + 3, y + 40);

    y += signatureBoxHeight + 4;

    if (locationData) {
      ensureSpace(10);
      const mapsUrl = buildGoogleMapsUrl(locationData.lat, locationData.lng);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9.2);
      doc.setTextColor(45, 58, 80);
      doc.text("Mapa de referencia:", margin, y + 4.5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(26, 111, 209);
      doc.textWithLink("Abrir ubicacion en Google Maps", margin + 33, y + 4.5, { url: mapsUrl });
      y += 8;
    }

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.6);
    doc.setTextColor(90, 102, 118);
    doc.text(`Generado: ${new Date().toLocaleString("es-CO")}`, margin, pageHeight - 6);

    const dataUri = doc.output("datauristring");
    return dataUri.includes(",") ? dataUri.split(",")[1] : dataUri;
  }

  async function uploadActaToDrive({ firmaAsesor, firmaResponsable, contentKey } = {}) {
    const asesorSignature = firmaAsesor ?? asesorRef.current?.toDataURL() ?? "";
    const responsableSignature = firmaResponsable ?? responsableRef.current?.toDataURL() ?? "";
    const requestId = createRequestId();
    const baseLogContext = {
      ...getActaLogContext(formData, actaType),
      requestId,
      contentKey,
    };

    try {
      setIsSending(true);
      setIsCalendarOpen(false);
      setSendStep("locating");
      logFrontendEvent("info", "acta.upload_started", baseLogContext);
      sileo.info({
        title: "Enviando acta",
        description: "Validando servicios antes de enviar.",
      });

      await assertUploadReadiness(baseLogContext);

      sileo.info({
        title: "Enviando acta",
        description: "Solicitando ubicacion del dispositivo.",
      });

      const capturedLocation = await captureLocationWithRetry();
      logFrontendEvent("info", "acta.location_captured", {
        ...baseLogContext,
        phase: "locating",
        hasLocation: Boolean(capturedLocation),
      });

      setSendStep("generating");
      const pdfBase64 = await buildPdfBase64(capturedLocation);
      const pdfBytes = base64ToBytes(pdfBase64);
      if (pdfBytes > MAX_VERCEL_FUNCTION_PAYLOAD_BYTES) {
        logFrontendEvent("error", "acta.pdf_too_large", {
          ...baseLogContext,
          phase: "generating",
          pdfBytes,
          maxBytes: MAX_VERCEL_FUNCTION_PAYLOAD_BYTES,
        });
        throw new Error("El PDF supera el tamano permitido. Contacta con soporte.");
      }
      logFrontendEvent("info", "acta.pdf_generated", {
        ...baseLogContext,
        phase: "generating",
        pdfBytes,
      });

      const idempotencyKey = await buildIdempotencyKey({
        fields: formData,
        actaType,
        firmaAsesor: asesorSignature,
        firmaResponsable: responsableSignature,
        location: capturedLocation,
        pdfBase64,
      });
      logFrontendEvent("info", "acta.idempotency_key_ready", {
        ...baseLogContext,
        phase: "uploading",
        idempotencyKey,
      });

      setSendStep("uploading");
      const response = await fetch(`${API_BASE}/api/drive/upload-pdf`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "X-Request-Id": requestId,
        },
        body: JSON.stringify({
          pdfBase64,
          fields: formData,
          location: capturedLocation,
          idempotencyKey,
        }),
      });

      setSendStep("saving");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        logFrontendEvent("error", "acta.upload_api_error", {
          ...baseLogContext,
          phase: "uploading",
          status: response.status,
          errorCode: payload?.error?.code || null,
          backendRequestId: payload?.requestId || null,
          actaCode: payload?.actaCode || null,
          idempotencyKey,
          message: resolveApiErrorMessage(payload, "No se pudo enviar a Drive."),
        });

        if (response.status === 401 && payload?.authUrl) {
          sileo.warning({
            title: "Google Drive sin autorizacion",
            description: buildApiErrorDescription(
              payload,
              "Se abrira la autorizacion de Google en una nueva pestana."
            ),
          });

          const authWindow = window.open(payload.authUrl, "_blank", "noopener,noreferrer");
          if (!authWindow) {
            sileo.info({
              title: "Ventana bloqueada",
              description: "Habilita pop-ups para completar la autorizacion de Google.",
            });
          }
          return null;
        }

        if (payload?.error?.code === "REQUEST_IN_PROGRESS") {
          sileo.info({
            title: "Solicitud en proceso",
            description: buildApiErrorDescription(payload, "La solicitud ya se esta procesando."),
          });
          return null;
        }

        throw new Error(buildApiErrorDescription(payload, "No se pudo enviar a Drive."));
      }

      const fileName = payload?.driveFile?.name || "acta.pdf";
      const warning = payload?.dbWarning || null;
      logFrontendEvent("info", "acta.upload_completed", {
        ...baseLogContext,
        phase: "saving",
        backendRequestId: payload?.requestId || null,
        actaCode: payload?.actaCode || null,
        driveFileId: payload?.driveFile?.id || null,
        fileName,
        hasDbWarning: Boolean(warning),
        idempotencyReplayed: Boolean(payload?.idempotency?.replayed),
      });

      if (payload?.idempotency?.replayed) {
        sileo.info({
          title: "Solicitud recuperada",
          description: "Se reutilizo una respuesta previa para evitar duplicados.",
        });
      }

      if (warning) {
        logFrontendEvent("warn", "acta.db_warning", {
          ...baseLogContext,
          phase: "saving",
          backendRequestId: payload?.requestId || null,
          actaCode: payload?.actaCode || null,
          warning,
        });
        sileo.warning({
          title: "Enviado con advertencia",
          description: `PDF subido a Drive, pero la base de datos reporto un problema. Soporte: ${payload?.requestId || requestId}`,
        });
      }

      sileo.success({
        title: "Acta subida a la nube",
        description: `Acta ${fileName} subida a la nube.`,
      });

      const result = {
        pdfBase64,
        fileName,
        contentKey,
      };
      if (contentKey) {
        lastSuccessfulUploadRef.current = result;
      }

      return result;
    } catch (error) {
      logFrontendEvent("error", "acta.upload_failed", {
        ...baseLogContext,
        message: error?.message || "No se pudo enviar a Drive.",
      });
      sileo.error({
        title: error?.title || "Error al enviar",
        description: error?.message || "No se pudo enviar a Drive.",
      });
      return null;
    } finally {
      setIsSending(false);
      setSendStep("idle");
    }
  }

  async function handlePrint() {
    if (isSending) return;
    if (!validateFormDataWithSchema()) return;
    if (!validateSignatures()) return;

    const firmaAsesor = asesorRef.current?.toDataURL() || "";
    const firmaResponsable = responsableRef.current?.toDataURL() || "";
    const contentKey = await buildActaContentKey({
      fields: formData,
      actaType,
      firmaAsesor,
      firmaResponsable,
    });
    const cachedUpload = lastSuccessfulUploadRef.current;

    if (cachedUpload?.contentKey === contentKey && cachedUpload?.pdfBase64) {
      try {
        downloadPdfFromBase64(
          cachedUpload.pdfBase64,
          cachedUpload.fileName || (actaType === "actividades" ? "acta-actividades.pdf" : "acta-visitas.pdf")
        );
        logFrontendEvent("info", "acta.download_started", {
          ...getActaLogContext(formData, actaType),
          source: "cache",
          contentKey,
          fileName: cachedUpload.fileName || null,
        });
        sileo.success({
          title: "Descarga iniciada",
          description: "Se esta descargando el PDF generado previamente para esta acta.",
        });
      } catch (error) {
        logFrontendEvent("error", "acta.download_failed", {
          ...getActaLogContext(formData, actaType),
          source: "cache",
          contentKey,
          message: error?.message || "No se pudo iniciar la descarga.",
        });
        sileo.error({
          title: "Error al descargar",
          description: "No se pudo iniciar la descarga del PDF. Intenta nuevamente.",
        });
      }
      return;
    }

    const uploadResult = await uploadActaToDrive({ firmaAsesor, firmaResponsable, contentKey });
    if (!uploadResult?.pdfBase64) return;

    try {
      downloadPdfFromBase64(
        uploadResult.pdfBase64,
        uploadResult.fileName || (actaType === "actividades" ? "acta-actividades.pdf" : "acta-visitas.pdf")
      );
      logFrontendEvent("info", "acta.download_started", {
        ...getActaLogContext(formData, actaType),
        source: "upload",
        contentKey,
        fileName: uploadResult.fileName || null,
      });
      sileo.success({
        title: "Descarga iniciada",
        description: "El PDF se envio a Drive y ahora se esta descargando en este dispositivo.",
      });
    } catch (error) {
      logFrontendEvent("error", "acta.download_failed", {
        ...getActaLogContext(formData, actaType),
        source: "upload",
        contentKey,
        message: error?.message || "No se pudo iniciar la descarga.",
      });
      sileo.error({
        title: "Error al descargar",
        description: "El PDF fue enviado a Drive, pero no se pudo descargar en este dispositivo.",
      });
    }
  }

  return (
    <main className="shell">
      <section className="document-surface">
        <header className="topbar glass-card">
          <div className="brand-wrap">
            <img
              src={theme === "dark" ? "/img/logo-oscuro.png" : "/img/logo-claro.png"}
              alt="Logo Mundo Ocupacional"
              className="brand-mark"
            />
            <div>
              <h1>{actaHeader.title}</h1>
            </div>
          </div>

          <div className="topbar-actions">
            <div className="field topbar-control no-print">
              <label htmlFor="actaType" className="field-label">
                Tipo de acta
              </label>
              <select
                id="actaType"
                name="actaType"
                value={actaType}
                onChange={(event) => setActaType(event.target.value)}
                disabled={isSending}
                aria-label="Tipo de acta"
              >
                {ACTA_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="field-date calendar-field topbar-control" ref={calendarRef}>
              <button
                type="button"
                className="calendar-trigger"
                onClick={() => setIsCalendarOpen((prev) => !prev)}
                disabled={isSending}
                aria-expanded={isCalendarOpen}
                aria-label="Abrir calendario"
              >
                <span>{`Fecha: ${formData.fecha || "Selecciona una fecha"}`}</span>
              </button>
              {isCalendarOpen ? (
                <div className="calendar-popover glass-card">
                  <DayPicker
                    mode="single"
                    selected={parseISODate(formData.fecha)}
                    onSelect={handleDateSelect}
                    locale={es}
                    weekStartsOn={1}
                    showOutsideDays
                    className="modern-daypicker"
                    startMonth={minCalendarDate}
                    endMonth={maxCalendarDate}
                    disabled={dayPickerDisabledMatchers}
                  />
                </div>
              ) : null}
              {errors.fecha ? <p className="error">{errors.fecha}</p> : null}
            </div>

            <button
              type="button"
              className="theme-toggle no-print"
              onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
              disabled={isSending}
              aria-label="Cambiar tema"
            >
              {theme === "dark" ? "Modo claro" : "Modo oscuro"}
            </button>

            <a
              href={SUPPORT_WA_URL}
              target="_blank"
              rel="noreferrer"
              className={`whatsapp-support no-print ${isSending ? "is-disabled" : ""}`}
              aria-label="Contactar soporte por WhatsApp"
              onClick={(event) => {
                if (!isSending) return;
                event.preventDefault();
              }}
            >
              <svg
                className="whatsapp-support-icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 11.5a8.5 8.5 0 0 1-12.3 7.5L4 20l1.2-3.5A8.5 8.5 0 1 1 20 11.5Z" />
                <path d="M9.4 8.8c.2-.3.4-.3.6-.2l1.1.5c.2.1.3.3.2.5l-.4 1c-.1.2 0 .4.1.6.3.4.8.9 1.4 1.2.2.1.4.1.6 0l.9-.4c.2-.1.4 0 .5.2l.5 1.1c.1.2.1.4-.2.6-.3.3-.7.5-1.2.5-.7 0-1.7-.4-2.7-1.2-1-.8-1.8-1.8-2.1-2.8-.2-.7-.2-1.3.1-1.6Z" />
              </svg>
              <span>Soporte</span>
            </a>
          </div>
        </header>

        <form className="form-grid" noValidate>
          <fieldset className="form-shell" disabled={isSending}>
            <p className="required-note">
              <span className="required-indicator" aria-hidden="true">
                *
              </span>{" "}
              Campos obligatorios
            </p>

            <section className="glass-card panel two-col">
              <label className="field">
                <span className="field-label">
                  Nombre o razon social de la sede
                  <span className="required-indicator" aria-hidden="true">
                    *
                  </span>
                </span>
                <input
                  id="razonSocial"
                  name="razonSocial"
                  type="text"
                  value={formData.razonSocial}
                  onChange={onFieldChange}
                  required
                />
                {errors.razonSocial ? <p className="error">{errors.razonSocial}</p> : null}
              </label>

              <label className="field">
                <span className="field-label">
                  Sede
                  <span className="required-indicator" aria-hidden="true">
                    *
                  </span>
                </span>
                <input id="sede" name="sede" type="text" value={formData.sede} onChange={onFieldChange} required />
                {errors.sede ? <p className="error">{errors.sede}</p> : null}
              </label>
            </section>

            <section className="glass-card panel two-col">
              <AlarmTimeField
                id="horaInicio"
                name="horaInicio"
                label="Hora inicio"
                value={formData.horaInicio}
                onChange={onTimeFieldChange}
                disabled={isSending}
                required
                error={errors.horaInicio}
              />

              <AlarmTimeField
                id="horaFin"
                name="horaFin"
                label="Hora fin"
                value={formData.horaFin}
                onChange={onTimeFieldChange}
                disabled={isSending}
                required
                error={errors.horaFin}
              />
            </section>

            <section className="glass-card panel two-col">
              <label className="field">
                <span className="field-label">
                  Contacto de la empresa
                  <span className="required-indicator" aria-hidden="true">
                    *
                  </span>
                </span>
                <input
                  id="contacto"
                  name="contacto"
                  type="text"
                  value={formData.contacto}
                  onChange={onFieldChange}
                  required
                />
                {errors.contacto ? <p className="error">{errors.contacto}</p> : null}
              </label>

              <label className="field">
                <span className="field-label">
                  Telefono
                  <span className="optional-indicator">(opcional)</span>
                </span>
                <input
                  id="telefono"
                  name="telefono"
                  type="tel"
                  value={formData.telefono}
                  onChange={onFieldChange}
                />
                {errors.telefono ? <p className="error">{errors.telefono}</p> : null}
              </label>

              <label className="field full-span">
                <span className="field-label">
                  Email
                  <span className="optional-indicator">(opcional)</span>
                </span>
                <input id="email" name="email" type="email" value={formData.email} onChange={onFieldChange} />
                {errors.email ? <p className="error">{errors.email}</p> : null}
              </label>
            </section>

            <section className="glass-card panel">
              <label className="field">
                <span className="field-label">
                  Participantes
                  <span className="required-indicator" aria-hidden="true">
                    *
                  </span>
                </span>
                <textarea
                  id="participantes"
                  name="participantes"
                  rows="4"
                  placeholder="Ejemplo: Juan Perez (Gerente), Ana Torres (SST), ..."
                  value={formData.participantes}
                  onChange={onFieldChange}
                  required
                ></textarea>
                {errors.participantes ? <p className="error">{errors.participantes}</p> : null}
              </label>
            </section>

            <section className="glass-card panel">
              <label className="field">
                <span className="field-label">
                  Temas tratados o actividades realizadas
                  <span className="required-indicator" aria-hidden="true">
                    *
                  </span>
                </span>
                <textarea
                  id="temasTratados"
                  name="temasTratados"
                  rows="6"
                  placeholder="Detalle de actividades y temas desarrollados durante la visita."
                  value={formData.temasTratados}
                  onChange={onFieldChange}
                  required
                ></textarea>
                {errors.temasTratados ? <p className="error">{errors.temasTratados}</p> : null}
              </label>
            </section>

            <section className="glass-card panel">
              <label className="field">
                <span className="field-label">
                  Planes de accion
                  <span className="required-indicator" aria-hidden="true">
                    *
                  </span>
                </span>
                <textarea
                  id="compromisos"
                  name="compromisos"
                  rows="4"
                  placeholder={`Realizar el plan de accion bajo la metodología :
P = Planear
H = Hacer
V = Verificar`}
                  value={formData.compromisos}
                  onChange={onFieldChange}
                  required
                ></textarea>
                {errors.compromisos ? <p className="error">{errors.compromisos}</p> : null}
              </label>
            </section>

            <section className="glass-card panel">
              <label className="field">
                <span className="field-label">
                  Observaciones
                  <span className="required-indicator" aria-hidden="true">
                    *
                  </span>
                </span>
                <textarea
                  id="observaciones"
                  name="observaciones"
                  rows="4"
                  placeholder="Observaciones adicionales de la visita."
                  value={formData.observaciones}
                  onChange={onFieldChange}
                  required
                ></textarea>
                {errors.observaciones ? <p className="error">{errors.observaciones}</p> : null}
              </label>
            </section>

            <section className="glass-card panel signature-grid">
              <div>
                <SignatureField ref={asesorRef} title="Firma del Participante (Consultor SST mundo ocupacional)" />
                <button type="button" className="ghost no-print" onClick={() => asesorRef.current?.clear()}>
                  Limpiar firma
                </button>
              </div>

              <div>
                <SignatureField ref={responsableRef} title="Firma responsable encargado de la empresa" />
                <button type="button" className="ghost no-print" onClick={() => responsableRef.current?.clear()}>
                  Limpiar firma
                </button>

                <label className="field signature-extra">
                  <span className="field-label">
                    Nombre del encargado de la empresa
                    <span className="required-indicator" aria-hidden="true">
                      *
                    </span>
                  </span>
                  <input
                    id="encargadoEmpresaNombre"
                    name="encargadoEmpresaNombre"
                    type="text"
                    value={formData.encargadoEmpresaNombre}
                    onChange={onFieldChange}
                    required
                  />
                  {errors.encargadoEmpresaNombre ? <p className="error">{errors.encargadoEmpresaNombre}</p> : null}
                </label>

                <div className="consent-wrap">
                  <label className="consent-label" htmlFor="aceptaCondicionesDatos">
                    <input
                      id="aceptaCondicionesDatos"
                      name="aceptaCondicionesDatos"
                      type="checkbox"
                      checked={Boolean(formData.aceptaCondicionesDatos)}
                      onChange={onFieldChange}
                      required
                    />
                    <span>He leido y acepto las condiciones de la visita y el tratamiento de mis datos.</span>
                  </label>

                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setIsDataPolicyModalOpen(true)}
                    aria-haspopup="dialog"
                    aria-expanded={isDataPolicyModalOpen}
                  >
                    Ver mas informacion del tratamiento de datos
                  </button>

                  {errors.aceptaCondicionesDatos ? <p className="error">{errors.aceptaCondicionesDatos}</p> : null}
                </div>
              </div>
            </section>

            <section className="actions no-print">
              {isSending ? <p className="send-status">Estado de envio: {sendStepLabel}</p> : null}

              <button type="button" className="solid" onClick={handleSaveDraft}>
                Guardar borrador
              </button>
              <button type="button" className="ghost" onClick={handleReset}>
                Restablecer
              </button>
              <button type="button" className="accent" onClick={handlePrint}>
                Guardar PDF
              </button>
            </section>
          </fieldset>
        </form>
      </section>

      {isDataPolicyModalOpen ? (
        <div className="modal-backdrop no-print" role="presentation" onClick={() => setIsDataPolicyModalOpen(false)}>
          <section
            className="glass-card legal-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="data-policy-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="legal-modal-header">
              <h2 id="data-policy-title">{DATA_POLICY_TITLE}</h2>
            </header>

            <div className="legal-modal-content">
              {DATA_POLICY_ITEMS.map((item, index) => {
                if (index !== 1) {
                  return <p key={item}>{item}</p>;
                }

                const withEmail = item.split("[EMAIL]");
                const withWeb = withEmail[1]?.split("[WEB]") || [];

                return (
                  <p key={item}>
                    {withEmail[0]}
                    <a className="legal-link" href={`mailto:${DATA_POLICY_EMAIL}`}>
                      {DATA_POLICY_EMAIL}
                    </a>
                    {withWeb[0]}
                    <a className="legal-link" href={DATA_POLICY_WEB_URL} target="_blank" rel="noreferrer">
                      www.mundoocupacional.com
                    </a>
                    {withWeb[1] || ""}
                  </p>
                );
              })}
            </div>

            <div className="legal-modal-actions">
              <button type="button" className="ghost" onClick={copyDataPolicyEmail}>
                Copiar correo
              </button>
              <button type="button" className="accent" onClick={() => setIsDataPolicyModalOpen(false)}>
                Entendido
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
