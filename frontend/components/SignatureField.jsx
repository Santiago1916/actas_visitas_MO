"use client";

import SignaturePad from "signature_pad";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

function resizeCanvas(canvas, signaturePad) {
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  const width = Math.max(canvas.offsetWidth, 320);
  const height = Math.max(canvas.offsetHeight, 180);
  const data = signaturePad.toData();

  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);

  signaturePad.clear();
  if (data.length) {
    signaturePad.fromData(data);
  }
}

const SignatureField = forwardRef(function SignatureField({ title }, ref) {
  const canvasRef = useRef(null);
  const signaturePadRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const signaturePad = new SignaturePad(canvas, {
      minWidth: 0.8,
      maxWidth: 2.4,
      penColor: "#f8fcff",
      throttle: 8,
    });

    signaturePadRef.current = signaturePad;
    resizeCanvas(canvas, signaturePad);

    const onResize = () => resizeCanvas(canvas, signaturePad);
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      signaturePad.off();
      signaturePadRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      clear: () => signaturePadRef.current?.clear(),
      toDataURL: () => {
        if (!signaturePadRef.current || signaturePadRef.current.isEmpty()) return "";
        return signaturePadRef.current.toDataURL("image/png");
      },
      fromDataURL: (dataUrl) => {
        if (!dataUrl || !signaturePadRef.current) return;
        signaturePadRef.current.fromDataURL(dataUrl);
      },
      isEmpty: () => signaturePadRef.current?.isEmpty() ?? true,
    }),
    []
  );

  return (
    <article className="signature-panel">
      <h3>{title}</h3>
      <canvas ref={canvasRef} className="signature-pad" aria-label={title}></canvas>
    </article>
  );
});

export default SignatureField;
