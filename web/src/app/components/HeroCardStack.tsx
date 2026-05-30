'use client';
import { useEffect, useRef } from 'react';
import s from './HeroCardStack.module.css';

const ArrowIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M7 17 17 7M17 7H7M17 7v10" />
  </svg>
);

const PinIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
    <circle cx="12" cy="10" r="3"/>
  </svg>
);

interface CardData {
  domain: string;
  company: string;
  title: string;
  location: string;
  salary: string;
  lastLca: string;
  lcaCount: string;
  poc: string;
}

const CARDS: CardData[] = [
  {
    domain: 'anthropic.com',
    company: 'Anthropic',
    title: 'Research Engineer, Model Capabilities',
    location: 'Remote, US · 1d ago',
    salary: 'Salary: $280K — $385K',
    lastLca: 'Last LCA: Jan 2026',
    lcaCount: '14 LCA in 2025',
    poc: 'PoC: Jared K (jared.***@anthropic.com)',
  },
  {
    domain: 'stripe.com',
    company: 'Stripe',
    title: 'Staff Software Engineer, Payments Infra',
    location: 'United States · 2d ago',
    salary: 'Salary: $245K — $310K',
    lastLca: 'Last LCA: Nov 2025',
    lcaCount: '67 LCA in 2025',
    poc: 'PoC: Claire M (claire.***@stripe.com)',
  },
  {
    domain: 'airbnb.com',
    company: 'Airbnb',
    title: 'Senior Software Engineer, Guest & Host',
    location: 'San Francisco Bay Area · 6h ago',
    salary: 'Salary: $191K — $223K',
    lastLca: 'Last LCA filed: March 2026',
    lcaCount: '1,211 LCAs filed in 2025',
    poc: 'PoC: Vanessa W (vanessa.***@airbnb.com)',
  },
];

const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

const ANIM = [
  {
    delay: 80,  dur: 520, opTo: 0.55,
    from: 'translateX(calc(-50% - 22px)) translateY(calc(-50% + 90px)) rotate(-4deg) scale(0.9)',
    mid:  'translateX(calc(-50% - 22px)) translateY(calc(-50% - 5px))  rotate(-4deg) scale(0.89)',
    to:   'translateX(calc(-50% - 22px)) translateY(-50%) rotate(-4deg) scale(0.88)',
  },
  {
    delay: 280, dur: 520, opTo: 0.55,
    from: 'translateX(calc(-50% + 22px)) translateY(calc(-50% + 90px)) rotate(4deg) scale(0.9)',
    mid:  'translateX(calc(-50% + 22px)) translateY(calc(-50% - 5px))  rotate(4deg) scale(0.89)',
    to:   'translateX(calc(-50% + 22px)) translateY(-50%) rotate(4deg) scale(0.88)',
  },
  {
    delay: 480, dur: 580, opTo: 1,
    from: 'translateX(-50%) translateY(calc(-50% + 90px)) scale(0.88)',
    mid:  'translateX(-50%) translateY(calc(-50% - 6px)) scale(0.93)',
    to:   'translateX(-50%) translateY(-50%) scale(0.9)',
  },
];

// Natural visual footprint of the 3-card cluster at scale(1)
const CLUSTER_W = 370;
const CLUSTER_H = 210;
const FILL = 0.80;

export default function HeroCardStack() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);
  const cardRefs = [
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
  ];

  // Card entry animations
  useEffect(() => {
    cardRefs.forEach((ref, i) => {
      const el = ref.current;
      if (!el) return;
      el.getAnimations().forEach(a => a.cancel());
      el.style.opacity = '0';
      const cfg = ANIM[i];
      el.animate(
        [
          { opacity: 0,        transform: cfg.from },
          { opacity: cfg.opTo, transform: cfg.mid, offset: 0.55 },
          { opacity: cfg.opTo, transform: cfg.to },
        ],
        { duration: cfg.dur, delay: cfg.delay, easing: EASE, fill: 'forwards' },
      );
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scale cluster to fill the container
  useEffect(() => {
    const wrap = wrapRef.current;
    const scaleEl = scaleRef.current;
    if (!wrap || !scaleEl) return;

    const update = () => {
      const { width: w, height: h } = wrap.getBoundingClientRect();
      const scale = Math.min((w * FILL) / CLUSTER_W, (h * FILL) / CLUSTER_H);
      scaleEl.style.transform = `scale(${Math.max(scale, 1)})`;
    };

    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    update();
    return () => ro.disconnect();
  }, []);

  return (
    <div className={s.wrap} ref={wrapRef}>
      <div className={s.hero}>
        <div className={s.heroScale} ref={scaleRef}>
          {/* Back-left: Anthropic */}
          <div className={`${s.card} ${s.backLeft}`} ref={cardRefs[0]}>
            <CardInner data={CARDS[0]} />
          </div>

          {/* Back-right: Stripe */}
          <div className={`${s.card} ${s.backRight}`} ref={cardRefs[1]}>
            <CardInner data={CARDS[1]} />
          </div>

          {/* Front: Airbnb */}
          <div className={`${s.card} ${s.front}`} ref={cardRefs[2]}>
            <CardInner data={CARDS[2]} nowrap />
          </div>
        </div>
      </div>
    </div>
  );
}

function CardInner({ data, nowrap }: { data: CardData; nowrap?: boolean }) {
  return (
    <>
      <div className={s.cardHdr}>
        <div className={s.cardHdrL}>
          <div className={s.coLogo}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`https://img.logo.dev/${data.domain}?token=pk_YdvbuXypSrijGM3tlqKDqA&size=64&format=png`}
              alt={data.company}
              width={32}
              height={32}
            />
          </div>
          <span className={s.coName}>{data.company}</span>
        </div>
        <button className={s.applyBtn} aria-hidden="true" tabIndex={-1}>
          Apply <ArrowIcon />
        </button>
      </div>
      <h3 className={s.jobTitle}>{data.title}</h3>
      <div className={s.meta}>
        <PinIcon />
        {data.location}
      </div>
      <div className={s.chips}>
        <span className={s.chip}>{data.salary}</span>
      </div>
      <div className={s.chips}>
        <span className={s.rpill}>Verified LCA Filings With Same Job Title</span>
      </div>
      <div className={s.chips} style={nowrap ? { flexWrap: 'nowrap' } : undefined}>
        <span className={s.chip}>{data.lastLca}</span>
        <span className={s.chip}>{data.lcaCount}</span>
      </div>
      <div className={s.chips}>
        <span className={s.chip}>{data.poc}</span>
      </div>
    </>
  );
}
