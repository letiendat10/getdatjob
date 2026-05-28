'use client';
import { useEffect, useRef, useState } from 'react';
import s from '../landing.module.css';

const DESIGN_W = 920;
const DESIGN_H = 450;
const TOP_CROP = 44;

export default function HeroMedia() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const w = el.offsetWidth;
      if (w > 0) setScale(w / DESIGN_W);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrapRef} className={s['hero-media']}>
      <iframe
        src="/hero-product.html"
        width={DESIGN_W}
        height={DESIGN_H}
        style={{
          border: 'none',
          position: 'absolute',
          top: 0,
          left: 0,
          transformOrigin: 'top left',
          transform: scale !== null
            ? `scale(${scale}) translateY(-${TOP_CROP}px)`
            : 'none',
          opacity: scale !== null ? 1 : 0,
          pointerEvents: 'none',
          display: 'block',
        }}
        title="getdatjob product preview"
        scrolling="no"
      />
    </div>
  );
}
