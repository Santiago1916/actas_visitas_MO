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
const SUPPORT_PHONE = "573022509856";
const SUPPORT_TEXT = "tengo problema con el acta de visitas mundo ocupacional";
const SUPPORT_WA_URL = `https://wa.me/${SUPPORT_PHONE}?text=${encodeURIComponent(SUPPORT_TEXT)}`;

const SEND_STEPS = {
  idle: "",
  locating: "Solicitando ubicacion...",
  generating: "Generando PDF...",
  uploading: "Subiendo PDF a Drive...",
  saving: "Guardando registro...",
};

const formSchema = z
  .object({
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener formato YYYY-MM-DD."),
    razonSocial: z.string().trim().min(1, "Ingresa la razon social.").max(220, "Razon social demasiado larga."),
    sede: z.string().trim().min(1, "Ingresa la sede.").max(180, "Sede demasiado larga."),
    horaInicio: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Hora inicio invalida."),
    horaFin: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Hora fin invalida."),
    contacto: z.string().trim().min(1, "Ingresa el contacto de la empresa.").max(180, "Contacto demasiado largo."),
    telefono: z.string().trim().min(7, "Telefono invalido.").max(30, "Telefono demasiado largo."),
    email: z.string().trim().email("Email invalido."),
    participantes: z.string().trim().min(3, "Ingresa los participantes.").max(2000, "Texto demasiado largo."),
    temasTratados: z.string().trim().min(5, "Ingresa los temas tratados.").max(6000, "Texto demasiado largo."),
    compromisos: z.string().trim().min(3, "Ingresa los compromisos.").max(4000, "Texto demasiado largo."),
    observaciones: z.string().trim().min(3, "Ingresa las observaciones.").max(4000, "Texto demasiado largo."),
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
  telefono: "",
  email: "",
  participantes: "",
  temasTratados: "",
  compromisos: "",
  observaciones: "",
};

let logoDataUrlPromise = null;

function getTodayLocal() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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

function buildGoogleMapsUrl(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

function base64ToBytes(base64 = "") {
  const clean = String(base64).replace(/\s/g, "");
  if (!clean) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

function requestBrowserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Este navegador no soporta geolocalizacion."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position),
      (error) => reject(error),
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0,
      }
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
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);

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

async function buildIdempotencyKey({ fields, firmaAsesor, firmaResponsable }) {
  const seed = JSON.stringify({
    fields,
    firmaAsesor,
    firmaResponsable,
  });

  const digest = await sha256Hex(seed);
  return `acta-${digest.slice(0, 40)}`;
}

export default function Page() {
  const [formData, setFormData] = useState({ ...initialData, fecha: getTodayLocal() });
  const [errors, setErrors] = useState({});
  const [isSending, setIsSending] = useState(false);
  const [sendStep, setSendStep] = useState("idle");
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [theme, setTheme] = useState("light");
  const [isThemeHydrated, setIsThemeHydrated] = useState(false);
  const asesorRef = useRef(null);
  const responsableRef = useRef(null);
  const calendarRef = useRef(null);
  const hasShownWelcomeRef = useRef(false);

  const sendStepLabel = useMemo(() => SEND_STEPS[sendStep] || "Procesando...", [sendStep]);

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
        setIsCalendarOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [isCalendarOpen]);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    try {
      const draft = JSON.parse(raw);
      if (draft.fields) {
        setFormData((prev) => ({ ...prev, ...draft.fields }));
      }

      setTimeout(() => {
        asesorRef.current?.fromDataURL(draft.firmaAsesor || "");
        responsableRef.current?.fromDataURL(draft.firmaResponsable || "");
      }, 40);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  function clearFieldError(name) {
    setErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  function onFieldChange(event) {
    const { name, value } = event.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    clearFieldError(name);

    if (name === "horaInicio" || name === "horaFin") {
      clearFieldError("horaInicio");
      clearFieldError("horaFin");
    }
  }

  function handleDateSelect(day) {
    if (!day) return;
    const nextDate = formatAsISODate(day);
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
      fecha: getTodayLocal(),
    });
    setErrors({});
    asesorRef.current?.clear();
    responsableRef.current?.clear();
    localStorage.removeItem(STORAGE_KEY);
  }

  async function captureLocationWithRetry() {
    const mapPosition = (position) => ({
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      capturedAt: new Date().toISOString(),
    });

    const tryCapture = async () => {
      const position = await requestBrowserLocation();
      return mapPosition(position);
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
        throw new Error("No se pudo determinar la ubicacion actual.");
      }
      if (error?.code === 3) {
        throw new Error("Tiempo agotado al solicitar ubicacion.");
      }
      throw new Error(error?.message || "Error obteniendo la ubicacion.");
    }
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
    doc.text("Acta de Visita", margin + 53, y + 13);
    doc.setTextColor(88, 101, 120);
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.text("Registro de visita SST", margin + 53, y + 18.5);
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
    drawTextSection("Compromisos", formData.compromisos, 5);
    drawTextSection("Observaciones", formData.observaciones, 5);

    const asesorSignatureRaw = asesorRef.current?.toDataURL() || "";
    const responsableSignatureRaw = responsableRef.current?.toDataURL() || "";
    const [asesorSignature, responsableSignature] = await Promise.all([
      optimizeSignatureDataUrl(asesorSignatureRaw),
      optimizeSignatureDataUrl(responsableSignatureRaw),
    ]);
    const signatureBoxHeight = 50;
    ensureSpace(signatureBoxHeight + 6);

    doc.setDrawColor(190, 200, 212);
    doc.roundedRect(margin, y, colWidth, signatureBoxHeight, 2, 2);
    doc.roundedRect(margin + colWidth + colGap, y, colWidth, signatureBoxHeight, 2, 2);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.4);
    doc.text("Firma asesor SST Mundo Ocupacional", margin + 3, y + 5);
    doc.text("Firma responsable encargado de la empresa", margin + colWidth + colGap + 3, y + 5);

    if (asesorSignature) {
      doc.addImage(asesorSignature, "PNG", margin + 3, y + 8, colWidth - 6, 28);
    }
    if (responsableSignature) {
      doc.addImage(responsableSignature, "PNG", margin + colWidth + colGap + 3, y + 8, colWidth - 6, 28);
    }

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

  function handlePrint() {
    if (isSending) return;
    if (!validateFormDataWithSchema()) return;
    if (!validateSignatures()) return;
    window.print();
  }

  async function handleSendToDrive() {
    if (isSending) return;
    if (!validateFormDataWithSchema()) return;
    if (!validateSignatures()) return;

    const firmaAsesor = asesorRef.current?.toDataURL() || "";
    const firmaResponsable = responsableRef.current?.toDataURL() || "";

    try {
      setIsSending(true);
      setIsCalendarOpen(false);
      setSendStep("locating");
      sileo.info({
        title: "Enviando acta",
        description: "Solicitando ubicacion del dispositivo.",
      });

      const idempotencyKey = await buildIdempotencyKey({
        fields: formData,
        firmaAsesor,
        firmaResponsable,
      });

      const capturedLocation = await captureLocationWithRetry();

      setSendStep("generating");
      const pdfBase64 = await buildPdfBase64(capturedLocation);
      const pdfBytes = base64ToBytes(pdfBase64);
      if (pdfBytes > MAX_VERCEL_FUNCTION_PAYLOAD_BYTES) {
        throw new Error(
          "El PDF es tuvo un fallo contacta con soporte."
        );
      }

      setSendStep("uploading");
      const response = await fetch(`${API_BASE}/api/drive/upload-pdf`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
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
        if (response.status === 401 && payload?.authUrl) {
          sileo.warning({
            title: "Google Drive sin autorizacion",
            description: "Se abrira la autorizacion de Google en una nueva pestana.",
          });

          const authWindow = window.open(payload.authUrl, "_blank", "noopener,noreferrer");
          if (!authWindow) {
            sileo.info({
              title: "Ventana bloqueada",
              description: "Habilita pop-ups para completar la autorizacion de Google.",
            });
          }
          return;
        }

        if (payload?.error?.code === "REQUEST_IN_PROGRESS") {
          sileo.info({
            title: "Solicitud en proceso",
            description: resolveApiErrorMessage(payload, "La solicitud ya se esta procesando."),
          });
          return;
        }

        throw new Error(resolveApiErrorMessage(payload, "No se pudo enviar a Drive."));
      }

      const fileName = payload?.driveFile?.name || "acta.pdf";
      const warning = payload?.dbWarning || null;

      if (payload?.idempotency?.replayed) {
        sileo.info({
          title: "Solicitud recuperada",
          description: "Se reutilizo una respuesta previa para evitar duplicados.",
        });
      }

      if (warning) {
        sileo.warning({
          title: "Enviado con advertencia",
          description: `PDF subido a Drive, pero la base de datos reporto: ${warning}`,
        });
      }

      sileo.success({
        title: "Acta subida a la nube",
        description: `Acta ${fileName} subida a la nube.`,
      });
    } catch (error) {
      sileo.error({
        title: "Error al enviar",
        description: error?.message || "No se pudo enviar a Drive.",
      });
    } finally {
      setIsSending(false);
      setSendStep("idle");
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
              <h1>Acta de Visita</h1>
            </div>
          </div>

          <div className="topbar-actions">
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
                    disabled={isSending}
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
            <section className="glass-card panel two-col">
              <label className="field">
                Nombre o razon social de la sede
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
                Sede
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
                error={errors.horaInicio}
              />

              <AlarmTimeField
                id="horaFin"
                name="horaFin"
                label="Hora fin"
                value={formData.horaFin}
                onChange={onTimeFieldChange}
                disabled={isSending}
                error={errors.horaFin}
              />
            </section>

            <section className="glass-card panel two-col">
              <label className="field">
                Contacto de la empresa
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
                Telefono
                <input
                  id="telefono"
                  name="telefono"
                  type="tel"
                  value={formData.telefono}
                  onChange={onFieldChange}
                  required
                />
                {errors.telefono ? <p className="error">{errors.telefono}</p> : null}
              </label>

              <label className="field full-span">
                Email
                <input id="email" name="email" type="email" value={formData.email} onChange={onFieldChange} required />
                {errors.email ? <p className="error">{errors.email}</p> : null}
              </label>
            </section>

            <section className="glass-card panel">
              <label className="field">
                Participantes
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
                Temas tratados o actividades realizadas
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
                Compromisos
                <textarea
                  id="compromisos"
                  name="compromisos"
                  rows="4"
                  placeholder="Acuerdos, responsables y fechas objetivo."
                  value={formData.compromisos}
                  onChange={onFieldChange}
                  required
                ></textarea>
                {errors.compromisos ? <p className="error">{errors.compromisos}</p> : null}
              </label>
            </section>

            <section className="glass-card panel">
              <label className="field">
                Observaciones
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
                <SignatureField ref={asesorRef} title="Firma asesor SST Mundo Ocupacional" />
                <button type="button" className="ghost no-print" onClick={() => asesorRef.current?.clear()}>
                  Limpiar firma
                </button>
              </div>

              <div>
                <SignatureField ref={responsableRef} title="Firma responsable encargado de la empresa" />
                <button type="button" className="ghost no-print" onClick={() => responsableRef.current?.clear()}>
                  Limpiar firma
                </button>
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
                Imprimir / Guardar PDF
              </button>
              <button type="button" className="accent" onClick={handleSendToDrive} disabled={isSending}>
                {isSending ? sendStepLabel : "Enviar a Drive"}
              </button>
            </section>
          </fieldset>
        </form>
      </section>
    </main>
  );
}
