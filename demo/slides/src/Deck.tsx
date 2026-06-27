import { useCallback, useEffect, useState } from "react";
import { slides } from "./slides";

export function Deck() {
  const [index, setIndex] = useState(() => indexFromHash());

  const go = useCallback((next: number) => {
    setIndex((current) => {
      const clamped = Math.max(0, Math.min(slides.length - 1, next));
      window.history.replaceState(null, "", `#${clamped + 1}`);
      return clamped;
    });
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "ArrowRight" || event.key === " " || event.key === "PageDown") {
        event.preventDefault();
        go(index + 1);
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        go(index - 1);
      } else if (event.key === "Home") {
        go(0);
      } else if (event.key === "End") {
        go(slides.length - 1);
      } else if (event.key.toLowerCase() === "f") {
        toggleFullscreen();
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, go]);

  useEffect(() => {
    function onHash() {
      setIndex(indexFromHash());
    }

    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const slide = slides[index];
  const progress = ((index + 1) / slides.length) * 100;

  return (
    <div className="deck" onClick={() => go(index + 1)}>
      <div className="stage" onClick={(event) => event.stopPropagation()}>
        <div className="slide" key={slide.id}>
          {slide.node}
        </div>
        <span className="footer-mark">Snitch</span>
        <span className="counter">
          {String(index + 1).padStart(2, "0")} / {String(slides.length).padStart(2, "0")}
        </span>
        <div className="chrome">
          <div className="bar" style={{ width: `${progress}%` }} />
        </div>
      </div>
      <div className="hint">← → or space to move · F for fullscreen · click to advance</div>
    </div>
  );
}

function indexFromHash(): number {
  const raw = Number.parseInt(window.location.hash.replace("#", ""), 10);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(raw - 1, slides.length - 1) : 0;
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
  } else {
    void document.documentElement.requestFullscreen();
  }
}
