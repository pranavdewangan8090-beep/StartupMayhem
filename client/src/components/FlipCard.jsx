import { useState } from 'react';

/**
 * A single identity card. First tap flips it face-up and permanently marks
 * it revealed (persisted by the parent) — once revealed, the card never
 * shows its back again, even after switching tabs or reloading. Tapping an
 * already-revealed card opens the enlarged modal view instead.
 */
export default function FlipCard({ category, title, tagline, description, tags, stats, revealed, onReveal, onEnlarge, children }) {
  const [locallyFlipped, setLocallyFlipped] = useState(false);
  const flipped = revealed || locallyFlipped;

  function handleTap() {
    if (!flipped) {
      setLocallyFlipped(true);
      onReveal?.(category);
    } else {
      onEnlarge?.();
    }
  }

  return (
    <div className="flip-card-wrap">
      <div className={`flip-card ${flipped ? 'flipped' : ''}`} onClick={handleTap}>
        <div className="flip-card-inner">
          <div className="flip-face back">
            <div className="card-back-pattern" />
            <div className="card-back-mark">SM</div>
            <div className="card-back-hint">Tap to reveal</div>
          </div>
          <div className="flip-face front">
            <div className="front-top">
              <span className={`pill cat-${category}`}>{category}</span>
              {tags?.length > 0 && (
                <div className="tag-row">
                  {tags.map((t) => <span key={t} className="tag-chip">{t}</span>)}
                </div>
              )}
              <div className="title">{title}</div>
              <div className="tagline">{tagline}</div>
            </div>
            <div className="desc">{description}</div>
            {stats?.length > 0 && (
              <div className="stat-chip-row">
                {stats.map((s) => (
                  <div key={s.label} className="stat-chip">
                    <span className="stat-chip-value">{s.value}</span>
                    <span className="stat-chip-label">{s.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}
