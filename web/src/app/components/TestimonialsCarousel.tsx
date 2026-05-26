"use client";

import { useRef, useEffect, useState } from "react";
import styles from "../landing.module.css";

const testimonials = [
  {
    body: "I went from 200 silent rejections on LinkedIn to 3 offers in six weeks. The verified-sponsor filter alone saved me months of dead-end applications.",
    name: "Priya Sharma",
    role: "SWE at Stripe · H-1B",
    initial: "P",
  },
  {
    body: "Got laid off on a Tuesday. Had four interviews lined up by Friday — all at companies I knew would sponsor. The 60-day plan kept me sane.",
    name: "Miguel Rodríguez",
    role: "Product Manager · TN",
    initial: "M",
  },
  {
    body: "As an Australian on E-3, every other job board was useless. getdatjob actually knows the difference between E-3-friendly and just “open to international”.",
    name: "Lachlan Wright",
    role: "Designer at Atlassian · E-3",
    initial: "L",
  },
  {
    body: "I'd never even heard of half these sponsors. The board surfaced companies I would never have applied to — and one of them ended up filing my green card.",
    name: "Anjali Krishnan",
    role: "Data Scientist · EB-2",
    initial: "A",
  },
  {
    body: "On OPT and panicking about cap season. getdatjob's STEM-OPT filter showed me exactly who would extend me. Three offers, one signature, done.",
    name: "Junho Park",
    role: "ML Engineer · STEM-OPT",
    initial: "J",
  },
];

export default function TestimonialsCarousel() {
  const trackRef = useRef<HTMLDivElement>(null);
  const [prevDisabled, setPrevDisabled] = useState(true);
  const [nextDisabled, setNextDisabled] = useState(false);

  const getStep = () => {
    const card = trackRef.current?.querySelector<HTMLElement>(`.${styles["t-card"]}`);
    if (!card) return 338;
    return card.getBoundingClientRect().width + 18;
  };

  const updateDisabled = () => {
    const t = trackRef.current;
    if (!t) return;
    setPrevDisabled(t.scrollLeft <= 4);
    setNextDisabled(t.scrollLeft + t.clientWidth >= t.scrollWidth - 4);
  };

  useEffect(() => {
    const t = trackRef.current;
    if (!t) return;
    t.addEventListener("scroll", updateDisabled, { passive: true });
    window.addEventListener("resize", updateDisabled);
    updateDisabled();
    return () => {
      t.removeEventListener("scroll", updateDisabled);
      window.removeEventListener("resize", updateDisabled);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className={styles["t-track"]} ref={trackRef}>
        {testimonials.map((t, i) => (
          <div key={i} className={styles["t-card"]}>
            <div className={styles["t-quote"]}>&ldquo;</div>
            <p className={styles["t-body"]}>{t.body}</p>
            <div className={styles["t-person"]}>
              <div className={styles["t-avatar"]}>{t.initial}</div>
              <div>
                <div className={styles["t-name"]}>{t.name}</div>
                <div className={styles["t-meta"]}>{t.role}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className={styles["t-nav"]}>
        <button
          className={styles["t-arrow"]}
          onClick={() => trackRef.current?.scrollBy({ left: -getStep(), behavior: "smooth" })}
          disabled={prevDisabled}
          aria-label="Previous"
        >
          ←
        </button>
        <button
          className={styles["t-arrow"]}
          onClick={() => trackRef.current?.scrollBy({ left: getStep(), behavior: "smooth" })}
          disabled={nextDisabled}
          aria-label="Next"
        >
          →
        </button>
      </div>
    </>
  );
}
