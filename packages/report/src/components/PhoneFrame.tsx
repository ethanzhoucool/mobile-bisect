import type { ReactNode } from 'react';

export interface PhoneFrameProps {
  width: number;
  children: ReactNode;
  /** Soft outer light while a run is in flight. */
  glow?: 'none' | 'blue' | 'red' | 'green';
  flipId?: string;
  className?: string;
}

const ASPECT = 2.06;

/**
 * Everything inside the screen is sized off `--sw`, so the same markup stays
 * legible whether the phone is 220px wide on the search stage or 300px wide in
 * the final comparison, no scale transform, no blurry text.
 */
export function PhoneFrame({ width, children, glow = 'none', flipId, className }: PhoneFrameProps) {
  const bezel = Math.round(width * 0.026);
  const sw = width - bezel * 2;
  return (
    <div
      className={`phone flip${className ? ` ${className}` : ''}`}
      data-glow={glow}
      data-flip-id={flipId}
      style={{
        width,
        height: Math.round(width * ASPECT),
        padding: bezel,
        borderRadius: Math.round(width * 0.155),
        // @ts-expect-error custom property
        '--sw': `${sw}px`,
        '--u': `${sw / 100}px`,
        '--screen-r': `${Math.round(width * 0.132)}px`,
      }}
    >
      <div className="phone-screen">
        <div className="phone-island" />
        {children}
        <div className="phone-home" />
      </div>
    </div>
  );
}
