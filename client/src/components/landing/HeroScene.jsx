import { Suspense, lazy, useEffect, useState } from 'react';

const Hero3D = lazy(() => import('./Hero3D.jsx'));

/**
 * Decides whether the real 3D core is worth loading at all: skipped for
 * reduced-motion users and on narrow/phone viewports, where a static
 * CSS glow reads just as well and costs nothing. Three.js is only ever
 * fetched when this resolves true.
 */
function useWantsHero3D() {
  const [wants, setWants] = useState(false);

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isWide = window.matchMedia('(min-width: 720px)').matches;
    setWants(!reduceMotion && isWide);
  }, []);

  return wants;
}

export default function HeroScene() {
  const wants3D = useWantsHero3D();

  return (
    <div className="hero-scene">
      <div className="hero-scene-fallback" aria-hidden="true" />
      {wants3D && (
        <Suspense fallback={null}>
          <Hero3D />
        </Suspense>
      )}
    </div>
  );
}
