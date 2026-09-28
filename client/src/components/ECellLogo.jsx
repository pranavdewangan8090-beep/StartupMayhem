/**
 * Official E-Cell NIT Trichy logo — the single source of truth for the
 * brand mark, served from /public/brand/ecell-logo.png (background-matte
 * stripped so it composites cleanly on dark surfaces; artwork itself is
 * untouched). Used at nav/header scale only — never stretched.
 */
export default function ECellLogo({ size = 32, className = '' }) {
  return (
    <img
      src="/brand/ecell-logo.png"
      alt="E-Cell NIT Trichy"
      width={size}
      height={size}
      className={`ecell-logo ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
