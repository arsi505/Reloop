'use client';

import { useEffect, useState } from 'react';

export function MotionSystem() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const root = document.documentElement;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.classList.add('motion-ready');

    const revealItems = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));

    if (reducedMotion || !('IntersectionObserver' in window)) {
      revealItems.forEach((item) => item.classList.add('is-visible'));
    } else {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            (entry.target as HTMLElement).classList.add('is-visible');
            observer.unobserve(entry.target);
          });
        },
        { rootMargin: '0px 0px -9% 0px', threshold: 0.12 },
      );

      revealItems.forEach((item) => observer.observe(item));
      return () => {
        observer.disconnect();
        root.classList.remove('motion-ready');
      };
    }

    return () => root.classList.remove('motion-ready');
  }, []);

  useEffect(() => {
    let frame = 0;
    const updateProgress = () => {
      frame = 0;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(scrollable > 0 ? Math.min(window.scrollY / scrollable, 1) : 0);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(updateProgress);
    };

    updateProgress();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-[2px] bg-transparent" aria-hidden="true">
      <span className="block h-full origin-left bg-reloop-signal will-change-transform" style={{ transform: `scaleX(${progress})` }} />
    </div>
  );
}
