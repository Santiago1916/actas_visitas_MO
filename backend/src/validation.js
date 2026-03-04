import { z } from "zod";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const IDEMPOTENCY_RE = /^[a-zA-Z0-9._:-]{8,120}$/;

const requiredText = (fieldName, max = 500) =>
  z
    .string({ required_error: `${fieldName} es obligatorio.` })
    .trim()
    .min(1, `${fieldName} es obligatorio.`)
    .max(max, `${fieldName} supera el maximo permitido (${max}).`);

const fieldsSchema = z
  .object({
    fecha: z
      .string({ required_error: "La fecha es obligatoria." })
      .regex(DATE_RE, "La fecha debe tener formato YYYY-MM-DD."),
    razonSocial: requiredText("La razon social", 220),
    sede: requiredText("La sede", 180),
    horaInicio: z
      .string({ required_error: "La hora de inicio es obligatoria." })
      .regex(TIME_RE, "La hora de inicio debe tener formato HH:mm."),
    horaFin: z
      .string({ required_error: "La hora de fin es obligatoria." })
      .regex(TIME_RE, "La hora de fin debe tener formato HH:mm."),
    contacto: requiredText("El contacto", 180),
    telefono: z
      .string({ required_error: "El telefono es obligatorio." })
      .trim()
      .min(7, "El telefono debe tener al menos 7 caracteres.")
      .max(30, "El telefono supera el maximo permitido (30)."),
    email: z.string({ required_error: "El email es obligatorio." }).trim().email("El email no es valido."),
    participantes: requiredText("Participantes", 2000),
    temasTratados: requiredText("Temas tratados", 6000),
    compromisos: requiredText("Compromisos", 4000),
    observaciones: requiredText("Observaciones", 4000),
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

const locationSchema = z
  .object({
    lat: z.coerce.number().min(-90, "Latitud fuera de rango.").max(90, "Latitud fuera de rango."),
    lng: z.coerce.number().min(-180, "Longitud fuera de rango.").max(180, "Longitud fuera de rango."),
    capturedAt: z
      .string()
      .datetime({ offset: true, message: "capturedAt debe ser una fecha ISO valida." }),
  })
  .strict();

const uploadPayloadSchema = z
  .object({
    pdfBase64: z
      .string({ required_error: "pdfBase64 es obligatorio." })
      .trim()
      .min(20, "pdfBase64 no es valido."),
    fields: fieldsSchema,
    location: locationSchema.nullable().optional(),
    idempotencyKey: z
      .string()
      .trim()
      .regex(IDEMPOTENCY_RE, "idempotencyKey no cumple el formato esperado.")
      .optional(),
  })
  .strict();

function normalizeIssues(issues = []) {
  return issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}

export function validateUploadPayload(input) {
  const result = uploadPayloadSchema.safeParse(input);
  if (result.success) {
    return {
      success: true,
      data: result.data,
      issues: [],
    };
  }

  return {
    success: false,
    data: null,
    issues: normalizeIssues(result.error.issues),
  };
}
