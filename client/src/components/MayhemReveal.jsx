import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';

const TIER_LABEL = { hit_hard: 'HIT HARD', hit: 'HIT', unaffected: 'UNAFFECTED', gains: 'GAINS' };

function formatDelta(applied) {
  if (!applied) return null;
  const parts = [];
  if (applied.cash_l) parts.push(`${applied.cash_l > 0 ? '+' : ''}₹${applied.cash_l / 10}M Cash`);
  if (applied.customers) parts.push(`${applied.customers > 0 ? '+' : ''}${applied.customers / 1000}k Customers`);
  if (applied.reputation) parts.push(`${applied.reputation > 0 ? '+' : ''}${applied.reputation} Reputation`);
  if (applied.innovation) parts.push(`${applied.innovation > 0 ? '+' : ''}${applied.innovation} Innovation`);
  return parts.length ? parts.join(' · ') : 'No change';
}

/**
 * Full-screen Mayhem reveal, driven entirely by the real crisis row from
 * fn_crisis_public() (title, description, tier, applied — the team's own
 * Market-card-determined tier and the effect already applied to their
 * resources) — never faked client-side. Plays a staged GSAP sequence: core
 * pulse → card appears → title → effect → tier state. Reduced-motion users
 * get the final state immediately, no animation.
 */
export default function MayhemReveal({ crisis, onClose }) {
  const coreRef = useRef(null);
  const cardRef = useRef(null);
  const titleRef = useRef(null);
  const effectRef = useRef(null);
  const stateRef = useRef(null);

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const els = [cardRef.current, titleRef.current, effectRef.current, stateRef.current];

    if (reduceMotion) {
      els.forEach((el) => el && gsap.set(el, { opacity: 1, y: 0, scale: 1 }));
      return;
    }

    const tl = gsap.timeline();
    tl.fromTo(coreRef.current, { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: 'power2.out' })
      .to(coreRef.current, { scale: 1.15, duration: 0.35, ease: 'power1.inOut', repeat: 3, yoyo: true })
      .fromTo(cardRef.current, { opacity: 0, y: 24, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: 'power2.out' }, '-=0.3')
      .fromTo(titleRef.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4 }, '-=0.15')
      .fromTo(effectRef.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4 }, '-=0.15')
      .fromTo(stateRef.current, { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.45, ease: 'back.out(1.7)' }, '-=0.1');

    return () => tl.kill();
  }, [crisis.crisis_id]);

  return (
    <div className="mayhem-overlay" role="dialog" aria-modal="true" aria-label="Market Mayhem reveal">
      <div className="mayhem-overlay-card" ref={cardRef}>
        <div className="mayhem-core-pulse" ref={coreRef} aria-hidden="true" />
        <span className="pill mayhem-event-pill">CRISIS</span>
        <h1 ref={titleRef}>{crisis.title}</h1>
        <p className="mayhem-overlay-story" ref={effectRef}>{crisis.description}</p>
        {crisis.tier && (
          <div className={`mayhem-state-pill state-${crisis.tier}`} ref={stateRef}>
            {TIER_LABEL[crisis.tier]}
          </div>
        )}
        {crisis.tier && (
          <p className="mayhem-overlay-effect">
            <b>Effect on your company:</b> {formatDelta(crisis.applied)}
          </p>
        )}
        <button className="btn btn-primary btn-block" style={{ marginTop: 20 }} onClick={onClose}>
          Acknowledge
        </button>
      </div>
    </div>
  );
}
