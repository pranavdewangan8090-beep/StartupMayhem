import { useState } from 'react';

/**
 * A single identity card. Tap 1: flips face-up (pure CSS 3D transform, no
 * library — stays smooth on ordinary phones). Tap 2 (while already
 * face-up): opens the enlarged modal view. The replace button lives outside
 * the flip surface so it never triggers a flip by accident.
 */
export default function FlipCard({ category, title, tagline, onEnlarge, children }) {
  const [flipped, setFlipped] = useState(false);

  function handleTap() {
    if (!flipped) {
      setFlipped(true);
    } else {
      onEnlarge?.();
    }
  }

  return (
    <div className="flip-card-wrap">
      <div className={`flip-card ${flipped ? 'flipped' : ''}`} onClick={handleTap}>
        <div className="flip-card-inner">
          <div className="flip-face back">
            <div className="logo-mark">🎴</div>
          </div>
          <div className="flip-face front">
            <div>
              <span className={`pill cat-${category}`}>{category}</span>
              <div className="title">{title}</div>
              <div className="tagline">{tagline}</div>
            </div>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}
