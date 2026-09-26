'use client';

import { useEffect } from 'react';

export function MotionSystem() {
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

  return null;
}
