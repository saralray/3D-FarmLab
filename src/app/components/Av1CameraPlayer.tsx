import { useEffect, useRef } from 'react';

// AV1-in-fragmented-MP4 codec string matching what server/bambuCamera.js's
// exact ffmpeg args actually produce — measured via a real encode + ffprobe
// (1280-wide/8fps/GOP-8 SVT-AV1, "auto" level, Main profile, 8-bit): profile
// 0, level 05, tier M(ain), 8-bit. Re-verify against real printer footage if
// the encode args change (resolution/bitrate shifts can change the level).
const AV1_MIME_CODEC = 'video/mp4; codecs="av01.0.05M.08"';

// A slow viewer's SourceBuffer would otherwise grow unbounded over a
// long-running live view — keep only a short window behind playback.
const BUFFER_TRIM_BEHIND_SECONDS = 10;

// The server disconnects viewers on every ffmpeg restart (a fresh process
// means a fresh init segment/codec session an existing MediaSource buffer
// can't splice into), so a handful of consecutive reconnects is normal
// operation, not a failure — only give up (and let the parent fall back to
// the legacy iframe/MJPEG view) after several attempts in a row fail.
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2000;

export function isAv1PlaybackSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaSource !== 'undefined' &&
    MediaSource.isTypeSupported(AV1_MIME_CODEC)
  );
}

interface Av1CameraPlayerProps {
  streamUrl: string;
  className?: string;
  onError: () => void;
}

// Plays the AV1 live-view stream via MediaSource Extensions: fetch the
// fragmented-MP4 byte stream, append each chunk to a SourceBuffer in order.
// Falls back to the parent's onError (which switches to the legacy
// iframe/MJPEG view) after a short internal retry budget is exhausted, rather
// than bubbling up on the very first disconnect — restarts of the
// server-side encode are a normal, if infrequent, occurrence.
export function Av1CameraPlayer({ streamUrl, className, onError }: Av1CameraPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!isAv1PlaybackSupported()) {
      onErrorRef.current();
      return;
    }

    let cancelled = false;
    let attempt = 0;
    let retryTimer: number | undefined;
    let currentAbort: AbortController | null = null;
    let currentObjectUrl: string | null = null;

    const teardownAttempt = () => {
      currentAbort?.abort();
      currentAbort = null;
      if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = null;
      }
    };

    const giveUp = () => {
      if (cancelled) return;
      cancelled = true;
      teardownAttempt();
      onErrorRef.current();
    };

    const scheduleRetry = () => {
      teardownAttempt();
      if (cancelled) return;
      attempt += 1;
      if (attempt > MAX_RECONNECT_ATTEMPTS) {
        giveUp();
        return;
      }
      retryTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
    };

    function connect() {
      if (cancelled) return;
      const abortController = new AbortController();
      currentAbort = abortController;
      const mediaSource = new MediaSource();
      const objectUrl = URL.createObjectURL(mediaSource);
      currentObjectUrl = objectUrl;
      if (video) video.src = objectUrl;

      let sourceBuffer: SourceBuffer | null = null;
      const pending: Uint8Array[] = [];

      const pumpQueue = () => {
        if (!sourceBuffer || sourceBuffer.updating || pending.length === 0) return;
        const next = pending.shift();
        if (!next) return;
        try {
          sourceBuffer.appendBuffer(next);
        } catch {
          scheduleRetry();
        }
      };

      const trimBuffer = () => {
        if (!sourceBuffer || sourceBuffer.updating || !video) return;
        const buffered = sourceBuffer.buffered;
        if (buffered.length === 0) return;
        const removeEnd = video.currentTime - BUFFER_TRIM_BEHIND_SECONDS;
        if (removeEnd > buffered.start(0) + 1) {
          try {
            sourceBuffer.remove(buffered.start(0), removeEnd);
          } catch {
            // Non-fatal — just skip this trim pass.
          }
        }
      };

      const onSourceOpen = async () => {
        if (cancelled || currentAbort !== abortController) return;
        try {
          sourceBuffer = mediaSource.addSourceBuffer(AV1_MIME_CODEC);
        } catch {
          scheduleRetry();
          return;
        }
        sourceBuffer.addEventListener('updateend', () => {
          trimBuffer();
          pumpQueue();
        });

        try {
          const response = await fetch(streamUrl, { signal: abortController.signal });
          if (currentAbort !== abortController) return;
          if (!response.ok || !response.body) {
            scheduleRetry();
            return;
          }
          attempt = 0; // a successful connect resets the retry budget
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (currentAbort !== abortController) return;
            if (done) {
              scheduleRetry();
              return;
            }
            if (value) {
              pending.push(value);
              pumpQueue();
            }
          }
        } catch (error) {
          if (currentAbort !== abortController) return;
          if ((error as Error)?.name === 'AbortError') return;
          scheduleRetry();
        }
      };

      mediaSource.addEventListener('sourceopen', onSourceOpen, { once: true });
    }

    connect();

    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      teardownAttempt();
      video.removeAttribute('src');
      video.load();
    };
  }, [streamUrl]);

  return <video ref={videoRef} className={className} autoPlay muted playsInline />;
}
