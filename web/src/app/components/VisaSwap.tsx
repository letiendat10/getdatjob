'use client';
import { useState, useEffect } from 'react';
import s from '../landing.module.css';

const visaTypes = ['H-1B', 'E-3', 'TN', 'OPT'];

export default function VisaSwap() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIndex(i => (i + 1) % visaTypes.length);
        setVisible(true);
      }, 300);
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  return (
    <em className={`${s['visa-swap']} ${visible ? '' : s['visa-swap-hidden']}`}>
      {visaTypes[index]}
    </em>
  );
}
