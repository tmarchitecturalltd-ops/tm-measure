"use client";

/**
 * components/measure/VoiceRecorder.tsx
 *
 * One-tap audio capture per room. Uses the browser's MediaRecorder
 * API (iOS Safari 16.4+, Android Chrome, every modern desktop).
 * Permissions are requested lazily on first Record tap; the stream
 * is released the moment the user stops recording so the OS doesn't
 * keep the mic indicator lit.
 *
 * Each clip becomes a RoomAudio entry on the parent room; the parent
 * form serialises + uploads them through the same Drive pipeline as
 * room photos.
 */

import { useEffect, useRef, useState } from "react";
import type { RoomAudio } from "@tm-designs/measure-core";

const newId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
};

export type VoiceRecorderProps = {
  memos: RoomAudio[];
  /** Fired when a new clip is added or an existing clip removed. */
  onChange: (next: RoomAudio[]) => void;
};

export default function VoiceRecorder({ memos, onChange }: VoiceRecorderProps) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  /** Held so unmount can release the mic even mid-recording. */
  const streamRef = useRef<MediaStream | null>(null);
  /** Latest memos, for the recorder's onstop handler.
   *
   *  onstop closes over whatever `memos` was when start() ran. Anything
   *  that changed the list while recording — deleting a memo, resuming
   *  a draft — was overwritten when the clip landed. Reading through a
   *  ref means onstop always appends to the current list. */
  const memosRef = useRef(memos);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    memosRef.current = memos;
    onChangeRef.current = onChange;
  });
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  /**
   * Release the microphone on unmount.
   *
   * The form pages one room at a time, so moving to the next room
   * unmounts this component. Without cleanup the recorder kept running
   * and the stream was never stopped: the OS recording indicator
   * stayed lit until the app was killed, and the clip was lost.
   */
  useEffect(() => {
    return () => {
      const r = recorderRef.current;
      if (r && r.state === "recording") {
        // Drop the handler first — appending to a room that is no
        // longer mounted would be a stray state update.
        r.onstop = null;
        try {
          r.stop();
        } catch {
          /* already stopping */
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  // Tick the elapsed counter while recording so the user has visual
  // feedback that the mic is live.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 200);
    return () => clearInterval(t);
  }, [recording]);

  const start = async () => {
    setError(null);
    try {
      // Guard the API itself: an insecure origin or an old WebView leaves
      // mediaDevices undefined, which would otherwise throw an opaque
      // "cannot read property getUserMedia of undefined".
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== "function"
      ) {
        setError(
          "Voice memos aren't supported on this device's browser. Please update the app or your system WebView.",
        );
        return;
      }
      if (typeof MediaRecorder === "undefined") {
        setError("Audio recording isn't available on this device.");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // Prefer audio/webm; iOS Safari only exposes audio/mp4 — let the
      // browser pick its supported default by passing no mimeType.
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const durationMs = Date.now() - startedAtRef.current;
        const mime = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mime });
        const uri = URL.createObjectURL(blob);
        const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
        const ts = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .slice(0, 19);
        const audio: RoomAudio = {
          id: newId(),
          uri,
          name: `voice-${ts}.${ext}`,
          mimeType: mime,
          sizeBytes: blob.size,
          durationMs,
        };
        onChangeRef.current([...memosRef.current, audio]);
        // Release the mic.
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      };
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      recorder.start();
      setRecording(true);
    } catch (err) {
      // Map the standard getUserMedia rejections onto instructions the
      // customer can actually act on, rather than a raw DOMException.
      const name = err instanceof Error ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError(
          "Microphone access was blocked. Enable the Microphone permission for TM Measure in your device Settings, then try again.",
        );
      } else if (name === "NotFoundError") {
        setError("No microphone was found on this device.");
      } else if (name === "NotReadableError") {
        setError(
          "The microphone is in use by another app. Close it and try again.",
        );
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Couldn't access the mic: ${msg}`);
      }
    }
  };

  const stop = () => {
    const r = recorderRef.current;
    if (r && r.state === "recording") r.stop();
    setRecording(false);
  };

  const remove = (id: string) => {
    const memo = memos.find((m) => m.id === id);
    if (memo) URL.revokeObjectURL(memo.uri);
    onChange(memos.filter((m) => m.id !== id));
  };

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        {!recording ? (
          <button
            type="button"
            onClick={start}
            className="inline-flex items-center gap-2 rounded-full border border-primary px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-primary hover:bg-primary hover:text-on-primary"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "16px" }} aria-hidden>mic</span>
            Record voice memo
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            className="inline-flex items-center gap-2 rounded-full bg-error px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-on-error hover:opacity-90"
            style={{ color: "#fff", backgroundColor: "#9e3b3b" }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: "16px" }} aria-hidden>stop_circle</span>
            Stop ({(elapsedMs / 1000).toFixed(1)}s)
          </button>
        )}
        <span className="text-[11px] text-on-surface-variant">
          {memos.length} memo{memos.length === 1 ? "" : "s"}
        </span>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-error">
          {error}
        </p>
      )}
      {memos.length > 0 && (
        <ul className="mt-3 space-y-2">
          {memos.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-outline-variant/30 bg-surface-container-lowest p-2"
            >
              <audio controls src={m.uri} preload="metadata" className="h-9 w-full max-w-[260px]" />
              <span className="text-[10px] uppercase tracking-widest text-on-surface-variant">
                {m.durationMs ? `${(m.durationMs / 1000).toFixed(1)}s` : ""}
              </span>
              <button
                type="button"
                onClick={() => remove(m.id)}
                className="ml-auto rounded px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:text-error"
                aria-label="Remove memo"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
