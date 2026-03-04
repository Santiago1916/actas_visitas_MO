"use client";

import { useEffect, useState } from "react";
import Picker from "react-mobile-picker";
import { createPortal } from "react-dom";

const HOURS = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));
const PERIODS = ["AM", "PM"];

function getCurrentPickerValue() {
  const now = new Date();
  const hhRaw = now.getHours();
  const mmRaw = now.getMinutes();
  const period = hhRaw >= 12 ? "PM" : "AM";
  const hour12 = hhRaw % 12 || 12;

  return {
    hour: String(hour12).padStart(2, "0"),
    minute: String(mmRaw).padStart(2, "0"),
    period,
  };
}

function parseToPickerValue(value) {
  if (!value || typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
    return getCurrentPickerValue();
  }

  const [hhRaw, mmRaw] = value.split(":").map(Number);
  const period = hhRaw >= 12 ? "PM" : "AM";
  const hour12 = hhRaw % 12 || 12;

  return {
    hour: String(hour12).padStart(2, "0"),
    minute: String(mmRaw).padStart(2, "0"),
    period,
  };
}

function to24Hour(value) {
  const hour12 = Number(value.hour);
  const minute = Number(value.minute);
  const isPm = value.period === "PM";

  let hour24 = hour12 % 12;
  if (isPm) hour24 += 12;

  return `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatDisplay(value) {
  if (!value || typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
    return "Selecciona hora";
  }

  const parsed = parseToPickerValue(value);
  return `${parsed.hour}:${parsed.minute} ${parsed.period}`;
}

export default function AlarmTimeField({
  id,
  name,
  label,
  value,
  disabled = false,
  error = "",
  onChange,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [pickerValue, setPickerValue] = useState(parseToPickerValue(value));

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  function handleOpen() {
    if (disabled) return;
    setPickerValue(parseToPickerValue(value));
    setIsOpen(true);
  }

  function handleClose() {
    setIsOpen(false);
  }

  function handleConfirm() {
    onChange?.(name, to24Hour(pickerValue));
    setIsOpen(false);
  }

  const modalContent =
    isOpen && isMounted
      ? createPortal(
          <>
            <button
              type="button"
              className="alarm-backdrop no-print"
              aria-label="Cerrar selector de hora"
              onClick={handleClose}
            />

            <section className="alarm-modal no-print" role="dialog" aria-modal="true" aria-label={label}>
              <header className="alarm-modal-header">
                <h3>{label}</h3>
                <p>Selecciona hora como en alarma</p>
              </header>

              <div className="alarm-picker-wrap">
                <Picker value={pickerValue} onChange={setPickerValue} height={216} itemHeight={44} wheelMode="natural">
                  <Picker.Column name="hour">
                    {HOURS.map((option) => (
                      <Picker.Item key={`hour-${option}`} value={option}>
                        {({ selected }) => (
                          <div className={`alarm-option ${selected ? "is-selected" : ""}`}>{option}</div>
                        )}
                      </Picker.Item>
                    ))}
                  </Picker.Column>

                  <Picker.Column name="minute">
                    {MINUTES.map((option) => (
                      <Picker.Item key={`minute-${option}`} value={option}>
                        {({ selected }) => (
                          <div className={`alarm-option ${selected ? "is-selected" : ""}`}>{option}</div>
                        )}
                      </Picker.Item>
                    ))}
                  </Picker.Column>

                  <Picker.Column name="period">
                    {PERIODS.map((option) => (
                      <Picker.Item key={`period-${option}`} value={option}>
                        {({ selected }) => (
                          <div className={`alarm-option ${selected ? "is-selected" : ""}`}>{option}</div>
                        )}
                      </Picker.Item>
                    ))}
                  </Picker.Column>
                </Picker>
              </div>

              <footer className="alarm-modal-actions">
                <button type="button" className="ghost" onClick={handleClose}>
                  Cancelar
                </button>
                <button type="button" className="accent" onClick={handleConfirm}>
                  Listo
                </button>
              </footer>
            </section>
          </>,
          document.body
        )
      : null;

  const isEmpty = !value || !/^\d{2}:\d{2}$/.test(value);

  return (
    <div className="field alarm-time-field">
      {label}

      <button
        type="button"
        id={id}
        className="alarm-trigger"
        onClick={handleOpen}
        disabled={disabled}
        aria-label={`Seleccionar ${label}`}
      >
        <span className={isEmpty ? "alarm-display-placeholder" : ""}>{formatDisplay(value)}</span>
      </button>

      {error ? <p className="error">{error}</p> : null}

      {modalContent}
    </div>
  );
}
