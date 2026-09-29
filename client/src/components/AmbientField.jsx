const PARTICLES = [
  { top: '12%', left: '8%', size: 5, tone: 'gold', delay: '0s', dur: '9s' },
  { top: '22%', left: '85%', size: 4, tone: 'cyan', delay: '1.2s', dur: '11s' },
  { top: '68%', left: '12%', size: 3, tone: 'cyan', delay: '2.4s', dur: '8s' },
  { top: '78%', left: '90%', size: 5, tone: 'gold', delay: '0.6s', dur: '10s' },
  { top: '40%', left: '5%', size: 3, tone: 'gold', delay: '3s', dur: '12s' },
  { top: '8%', left: '55%', size: 4, tone: 'cyan', delay: '1.8s', dur: '9.5s' },
  { top: '88%', left: '45%', size: 3, tone: 'gold', delay: '2.2s', dur: '10.5s' },
  { top: '55%', left: '94%', size: 4, tone: 'cyan', delay: '0.9s', dur: '8.5s' },
];

/**
 * Cheap ambient motion for pages that don't carry the full R3F hero (login,
 * and any other utility screen that still wants to feel like the
 * Mayhemverse): drifting glow orbs + floating particle dots, transform/
 * opacity only so it's GPU-friendly, no canvas/WebGL involved. Frozen
 * entirely under prefers-reduced-motion via CSS, so no JS branching needed.
 */
export default function AmbientField() {
  return (
    <div className="ambient-field" aria-hidden="true">
      <div className="ambient-orb orb-gold" />
      <div className="ambient-orb orb-cyan" />
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          className={`ambient-particle tone-${p.tone}`}
          style={{
            top: p.top,
            left: p.left,
            width: p.size,
            height: p.size,
            animationDelay: p.delay,
            animationDuration: p.dur,
          }}
        />
      ))}
    </div>
  );
}
