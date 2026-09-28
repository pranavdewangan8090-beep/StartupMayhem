import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';

function resolveState(crisis) {
  if (!crisis.is_affected) return { key: 'safe', label: 'SAFE', className: 'safe' };
  if (crisis.my_status === 'used_card' || crisis.my_status === 'traded') {
    return { key: 'protected', label: 'PROTECTED', className: 'protected' };
  }
  return { key: 'affected', label: 'AFFECTED', className: 'affected' };
}

/**
 * Full-screen Mayhem reveal, driven entirely by the real crisis row from
 * fn_crisis_public() (title, description, is_affected, my_status) — never
 * faked client-side. Plays a staged GSAP sequence: core pulse → card
 * appears → title → effect → affected/protected/safe state. Reduced-motion
 * users get the final state immediately, no animation.
 */
export default function MayhemReveal({ crisis, onClose }) {
  const coreRef = useRef(null);
  const cardRef = useRef(null);
  const titleRef = useRef(null);
  const effectRef = useRef(null);
  const stateRef = useRef(null);

  const resolved = resolveState(crisis);

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
        <span className="pill mayhem-event-pill">MARKET MAYHEM</span>
        <h1 ref={titleRef}>{crisis.title}</h1>
        <p className="mayhem-overlay-story" ref={effectRef}>{crisis.description}</p>
        <div className={`mayhem-state-pill state-${resolved.className}`} ref={stateRef}>
          {resolved.label}
        </div>
        {crisis.useful_card_names?.length > 0 && (
          <p className="mayhem-overlay-effect">
            <b>Useful action cards:</b> {crisis.useful_card_names.join(', ')}
          </p>
        )}
        <button className="btn btn-primary btn-block" style={{ marginTop: 20 }} onClick={onClose}>
          Acknowledge
        </button>
      </div>
    </div>
  );
}
