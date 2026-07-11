"use client";

import { useRef, useEffect, useState } from "react";

interface BackgroundVideoProps {
  /** 0–1 opacity of the dark overlay on top of the video */
  overlayOpacity?: number;
}

// Instant base layer beneath the video — pure CSS, GPU-composited, zero network.
// Shows on the very first frame so the background never flashes flat black while
// the (now tiny) video and its poster paint.
function GradientBase() {
  return (
    <div
      aria-hidden
      className="absolute inset-0"
      style={{
        background:
          "radial-gradient(120% 90% at 20% 10%, rgba(34,211,238,0.16), transparent 55%)," +
          "radial-gradient(110% 90% at 85% 30%, rgba(192,132,252,0.14), transparent 55%)," +
          "radial-gradient(130% 100% at 50% 100%, rgba(99,102,241,0.12), transparent 60%)," +
          "#050505",
        backgroundSize: "180% 180%, 180% 180%, 180% 180%, auto",
        animation: "bgAuroraDrift 24s ease-in-out infinite alternate",
        willChange: "background-position",
      }}
    />
  );
}

export default function BackgroundVideo({ overlayOpacity = 0.55 }: BackgroundVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Only Save-Data / reduced-motion users skip the video entirely (gradient only).
  // Everyone else mounts it immediately — the asset is ~0.5 MB and served from the
  // app's own CDN, so there's nothing heavy to defer anymore.
  const [skip, setSkip] = useState(false);

  useEffect(() => {
    const conn = (navigator as unknown as {
      connection?: { saveData?: boolean };
    }).connection;
    const saveData = conn?.saveData === true;
    const reduceMotion =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (saveData || reduceMotion) setSkip(true);
  }, []);

  useEffect(() => {
    if (skip) return;
    const video = videoRef.current;
    if (!video) return;

    let animId: number | null = null;
    let loopTimer: ReturnType<typeof setTimeout> | null = null;

    function animateFade(target: number, duration: number) {
      if (!video) return;
      if (animId) cancelAnimationFrame(animId);
      const start = parseFloat(video.style.opacity || "0");
      const t0 = performance.now();
      function step(now: number) {
        const p = Math.min((now - t0) / duration, 1);
        video!.style.opacity = String(start + (target - start) * p);
        if (p < 1) animId = requestAnimationFrame(step);
      }
      animId = requestAnimationFrame(step);
    }

    const tryPlay = () => { video.play().catch(() => {}); };

    // Reveal as soon as the first frame is decodable — do NOT gate visibility
    // solely on the "playing" event. Chrome can refuse muted autoplay for an
    // element that's effectively invisible (opacity:0), which left the video
    // hidden forever: no autoplay → no "playing" → opacity stuck at 0 (the bug).
    // Showing the first frame/poster also gives a graceful fallback if a browser
    // blocks autoplay entirely.
    // Reveal by setting opacity directly and letting the element's own CSS
    // `transition: opacity` animate it. Don't use the rAF fade here: rAF is
    // throttled in background tabs, which would leave the video invisible until
    // the tab is focused. Setting the property applies regardless.
    const reveal = () => {
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      video.style.transition = "opacity 0.6s ease";
      video.style.opacity = "1";
    };

    const onLoaded = () => { reveal(); tryPlay(); };
    const onPlaying = () => reveal();

    const onTimeUpdate = () => {
      const rem = video.duration - video.currentTime;
      if (rem <= 0.55 && parseFloat(video.style.opacity || "1") > 0.01) {
        animateFade(0, 400);
      }
    };

    const onEnded = () => {
      if (animId) cancelAnimationFrame(animId);
      video.style.opacity = "0";
      loopTimer = setTimeout(() => {
        video.currentTime = 0;
        reveal();
        tryPlay();
      }, 100);
    };

    // If autoplay was blocked, resume on the first user gesture or when the tab
    // becomes visible again.
    const onGesture = () => tryPlay();
    const onVisible = () => { if (!document.hidden) tryPlay(); };

    video.addEventListener("loadeddata", onLoaded);
    video.addEventListener("canplay", tryPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", onEnded);
    window.addEventListener("pointerdown", onGesture, { once: true });
    document.addEventListener("visibilitychange", onVisible);

    // Cover the case where the asset is already buffered (cached) before the
    // listeners attached: reveal + play right away.
    if (video.readyState >= 2) onLoaded();
    tryPlay();

    return () => {
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("canplay", tryPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", onEnded);
      window.removeEventListener("pointerdown", onGesture);
      document.removeEventListener("visibilitychange", onVisible);
      if (animId) cancelAnimationFrame(animId);
      if (loopTimer) clearTimeout(loopTimer);
    };
  }, [skip]);

  return (
    <>
      <style>{`@keyframes bgAuroraDrift{0%{background-position:0% 0%,100% 0%,50% 100%,0 0}100%{background-position:100% 100%,0% 100%,50% 0%,0 0}}`}</style>
      <GradientBase />
      {!skip && (
        <video
          ref={videoRef}
          src="/bg-hero.mp4"
          poster="/bg-hero.jpg"
          className="absolute inset-0 w-full h-full object-cover object-bottom"
          muted
          autoPlay
          playsInline
          preload="auto"
          style={{ opacity: 0, transition: "opacity 0.9s ease" }}
        />
      )}
      <div
        className="absolute inset-0"
        style={{ background: `rgba(0,0,0,${overlayOpacity})` }}
      />
    </>
  );
}
