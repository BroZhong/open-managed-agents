import { useCallback, useEffect, useRef, useState } from "react";
import type { FileSource } from "@/lib/file-source";

export type PreviewUrlLoader = NonNullable<FileSource["previewUrl"]>;

/** Cancel abandoned signing and bound each consecutive media failure chain. */
export function useMediaPreviewUrl(path: string, getPreviewUrl: PreviewUrlLoader, enabled = true) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const retriedRef = useRef(false);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const markLoaded = useCallback(() => {
    clearTimeout(loadTimer.current);
  }, []);

  const markRecovered = useCallback(() => {
    retriedRef.current = false;
  }, []);

  const handleError = useCallback(() => {
    clearTimeout(loadTimer.current);
    if (!retriedRef.current) {
      retriedRef.current = true;
      setUrl(null);
      setRetry((value) => value + 1);
    } else {
      setError(true);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const controller = new AbortController();
    // Covers signing and media that never emits load/error. The user can
    // retry via Refresh or download after the single automatic retry.
    loadTimer.current = setTimeout(handleError, 60_000);
    void getPreviewUrl(path, { signal: controller.signal, forceRefresh: retry > 0 })
      .then((value) => {
        if (alive) setUrl(value);
      })
      .catch(() => {
        if (alive) {
          clearTimeout(loadTimer.current);
          setError(true);
        }
      });
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(loadTimer.current);
    };
  }, [enabled, path, getPreviewUrl, retry, handleError]);

  return { url, error, handleError, markLoaded, markRecovered };
}

/** Shared playback recovery for audio and video; metadata alone is not success. */
export function usePlayableMediaPreview(path: string, getPreviewUrl: PreviewUrlLoader) {
  const preview = useMediaPreviewUrl(path, getPreviewUrl);
  const resumeRef = useRef<{ time: number; playing: boolean } | null>(null);
  const playbackIntent = useRef(false);
  const progressRef = useRef<{ time: number; clock: number } | null>(null);
  const clearProgress = () => { progressRef.current = null; };
  const mediaRef = useCallback((media: HTMLMediaElement | null) => {
    if (!media) return;
    return () => {
      // Detaching a media element alone can leave its native range download
      // active. Explicitly unload it when switching files or signed URLs.
      media.pause();
      media.removeAttribute("src");
      media.load();
    };
  }, []);

  const mediaEvents = {
    onError(event: { currentTarget: HTMLMediaElement }) {
      const media = event.currentTarget;
      resumeRef.current = { time: media.currentTime, playing: playbackIntent.current || !media.paused };
      clearProgress();
      preview.handleError();
    },
    onLoadedMetadata(event: { currentTarget: HTMLMediaElement }) {
      preview.markLoaded();
      const resume = resumeRef.current;
      if (resume) {
        event.currentTarget.currentTime = resume.time;
        if (resume.playing) void event.currentTarget.play().catch(() => undefined);
        resumeRef.current = null;
      }
    },
    onTimeUpdate(event: { currentTarget: HTMLMediaElement }) {
      const media = event.currentTarget;
      if (media.paused || media.seeking) { clearProgress(); return; }
      const progress = progressRef.current;
      if (!progress) {
        progressRef.current = { time: media.currentTime, clock: Date.now() };
      } else if (Date.now() - progress.clock >= 1_000 && media.currentTime - progress.time >= 1) {
        // Decoding and advancing for a full second confirms recovery. A file
        // that reports metadata but fails decoding cannot reset the budget.
        preview.markRecovered();
      }
    },
    onSeeking: clearProgress,
    onWaiting: clearProgress,
    onPlay() { playbackIntent.current = true; },
    onPause(event: { currentTarget: HTMLMediaElement }) {
      clearProgress();
      // Browsers may pause before emitting an error. Preserve the user's play
      // intent across that automatic pause, while honoring a manual pause.
      if (!event.currentTarget.error) playbackIntent.current = false;
    },
    onEnded() { playbackIntent.current = false; clearProgress(); },
  };
  return { url: preview.url, error: preview.error, mediaEvents, mediaRef };
}
