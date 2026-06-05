"use client";

/**
 * components/PhotoAnnotator.tsx
 *
 * Modal canvas tool that lets the architect draw on top of any
 * submitted photo (red / gold ink, freehand). On save the canvas is
 * exported as JPEG, POSTed to the Apps Script `save_annotation`
 * action, and the new Drive URL is handed back to the parent so the
 * review page can swap in the annotated link.
 *
 * Source images are loaded with crossOrigin="anonymous" so the
 * resulting canvas isn't tainted; Google Drive serves
 * `Access-Control-Allow-Origin: *` on its uc?id= endpoints, which is
 * what the Apps Script email-rewrite uses.
 */

import { useEffect, useRef, useState } from "react";

type Tool = {
  color: string;
  width: number;
  label: string;
};

const TOOLS: Tool[] = [
  { color: "#d12d2d", width: 6, label: "Red 6 px" },
  { color: "#d12d2d", width: 3, label: "Red 3 px" },
  { color: "#b89650", width: 6, label: "Gold 6 px" },
  { color: "#1c1c1a", width: 4, label: "Black 4 px" },
];

export type PhotoAnnotatorProps = {
  open: boolean;
  imageUrl: string;
  /** Filename to suggest for the annotated copy. */
  suggestedName: string;
  /** Apps Script `/exec` endpoint. */
  endpoint: string;
  /** Admin secret already entered on the console. */
  secret: string;
  /** Submission ID — Apps Script needs this to route the upload. */
  submissionId: string;
  onClose: () => void;
  /** Fired after a successful save with the new Drive URL. */
  onSaved: (driveUrl: string) => void;
};

export default function PhotoAnnotator({
  open,
  imageUrl,
  suggestedName,
  endpoint,
  secret,
  submissionId,
  onClose,
  onSaved,
}: PhotoAnnotatorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  const drawingRef = useRef(false);
  const [tool, setTool] = useState<Tool>(TOOLS[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  // Load the source image once per open. We composite it onto the
  // canvas so the drawing layer + photo render to one JPEG on save.
  useEffect(() => {
    if (!open) return;
    setImgLoaded(false);
    setError(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      baseImgRef.current = img;
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Cap canvas at 1600 px long edge to keep the upload small.
      const longEdge = Math.max(img.width, img.height);
      const scale = longEdge > 1600 ? 1600 / longEdge : 1;
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      setImgLoaded(true);
    };
    img.onerror = () =>
      setError(
        "Couldn't load image — Drive may be blocking the request from this device.",
      );
    img.src = imageUrl;
    return () => {
      baseImgRef.current = null;
    };
  }, [open, imageUrl]);

  const ctxOf = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
      ctx: canvas.getContext("2d"),
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = ctxOf(e);
    if (!c?.ctx) return;
    drawingRef.current = true;
    c.ctx.beginPath();
    c.ctx.moveTo(c.x, c.y);
    c.ctx.lineCap = "round";
    c.ctx.lineJoin = "round";
    c.ctx.strokeStyle = tool.color;
    c.ctx.lineWidth = tool.width;
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const c = ctxOf(e);
    if (!c?.ctx) return;
    c.ctx.lineTo(c.x, c.y);
    c.ctx.stroke();
  };
  const onPointerUp = () => {
    drawingRef.current = false;
  };

  const clearAll = () => {
    const canvas = canvasRef.current;
    const img = baseImgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };

  const save = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    setError(null);
    try {
      const dataUri = canvas.toDataURL("image/jpeg", 0.85);
      const r = await fetch(endpoint, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "save_annotation",
          id: submissionId,
          secret,
          name: suggestedName,
          dataUri,
        }),
      });
      if (!r.ok) throw new Error(`Server responded ${r.status}`);
      const data: { ok?: boolean; error?: string; driveUrl?: string } = await r.json();
      if (data.ok === false || !data.driveUrl) {
        throw new Error(data.error || "Save failed.");
      }
      onSaved(data.driveUrl);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="annot-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/70"
        aria-label="Close annotator"
        onClick={onClose}
      />
      <div className="relative w-full max-w-3xl rounded-2xl border border-outline-variant/30 bg-surface p-5 shadow-2xl">
        <header className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="annot-title" className="font-headline text-xl text-on-surface">
              Annotate photo
            </h2>
            <p className="mt-1 text-xs text-on-surface-variant">
              Draw on the image, then Save — your annotated copy is added
              to the submission&apos;s Drive folder.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-outline-variant/40 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-on-surface"
          >
            Close
          </button>
        </header>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {TOOLS.map((t) => (
            <button
              key={t.label}
              type="button"
              onClick={() => setTool(t)}
              aria-pressed={tool === t}
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest transition ${
                tool === t
                  ? "bg-primary text-on-primary shadow-sm"
                  : "bg-surface-container-high text-on-surface"
              }`}
            >
              <span
                aria-hidden
                style={{
                  width: `${t.width + 4}px`,
                  height: `${t.width + 4}px`,
                  borderRadius: "50%",
                  background: t.color,
                  display: "inline-block",
                }}
              />
              {t.label}
            </button>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="rounded-full border border-outline-variant/40 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-surface"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !imgLoaded}
            className="rounded-full bg-primary px-4 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save annotation"}
          </button>
        </div>
        {error && (
          <p role="alert" className="mb-3 rounded-md bg-error/10 px-3 py-2 text-sm text-error">
            {error}
          </p>
        )}
        <div
          className="overflow-auto rounded-md border border-outline-variant/30 bg-surface-container-lowest"
          style={{ maxHeight: "70vh" }}
        >
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            style={{
              touchAction: "none",
              maxWidth: "100%",
              display: "block",
              cursor: "crosshair",
            }}
          />
          {!imgLoaded && !error && (
            <p className="p-6 text-center text-sm text-on-surface-variant">
              Loading image…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
