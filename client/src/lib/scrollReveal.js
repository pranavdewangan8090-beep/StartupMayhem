import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

/**
 * Fades/slides in every `[data-reveal]` element inside `root` as it enters
 * the viewport. Skipped entirely for prefers-reduced-motion — elements are
 * just left visible. Returns a cleanup function.
 */
export function initScrollReveal(root) {
  if (!root) return () => {};

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const elements = root.querySelectorAll('[data-reveal]');

  if (reduceMotion) {
    elements.forEach((el) => el.classList.add('reveal-visible'));
    return () => {};
  }

  const triggers = [];
  elements.forEach((el, i) => {
    gsap.set(el, { opacity: 0, y: 28 });
    const trigger = ScrollTrigger.create({
      trigger: el,
      start: 'top 88%',
      once: true,
      onEnter: () => {
        gsap.to(el, {
          opacity: 1,
          y: 0,
          duration: 0.7,
          delay: (i % 3) * 0.06,
          ease: 'power2.out',
        });
      },
    });
    triggers.push(trigger);
  });

  return () => triggers.forEach((t) => t.kill());
}
