"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const HERO_IMAGES = [
  "https://images.pexels.com/photos/1396122/pexels-photo-1396122.jpeg?auto=compress&cs=tinysrgb&w=1400&h=1000&fit=crop",
  "https://images.pexels.com/photos/2724749/pexels-photo-2724749.jpeg?auto=compress&cs=tinysrgb&w=1400&h=1000&fit=crop",
  "https://images.pexels.com/photos/1115804/pexels-photo-1115804.jpeg?auto=compress&cs=tinysrgb&w=1400&h=1000&fit=crop",
  "https://images.pexels.com/photos/323780/pexels-photo-323780.jpeg?auto=compress&cs=tinysrgb&w=1400&h=1000&fit=crop",
  "https://images.pexels.com/photos/1029599/pexels-photo-1029599.jpeg?auto=compress&cs=tinysrgb&w=1400&h=1000&fit=crop",
];

const MARQUEE_ITEMS = [
  "Planning drawings",
  "Structural calculations",
  "Building regulations",
  "Loft conversions",
  "Extensions",
  "2-week guaranteed turnaround",
  "100% online",
  "UK wide service",
];

export default function Hero() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setActive((i) => (i + 1) % HERO_IMAGES.length);
    }, 5000);
    return () => window.clearInterval(id);
  }, []);

  const marqueeSpans = (
    <>
      {MARQUEE_ITEMS.map((label) => (
        <span key={label}>
          <span>{label}</span>
          <span className="mdot">·</span>
        </span>
      ))}
    </>
  );

  return (
    <>
      <section id="hero" className="hero-split">
        <div className="hero-split-left">
          <div className="eyebrow-line">Online Architectural Plans · UK Wide</div>
          <h1
            className="font-headline mb-6 text-on-surface"
            style={{
              fontSize: "clamp(2.4rem, 4.5vw, 5rem)",
              lineHeight: 1.05,
              letterSpacing: "-0.02em",
            }}
          >
            Extension Plans
            <br />
            in 2 Weeks 
            <br />
            <em className="text-primary italic">No Site Visit.</em>
          </h1>
          <p
            className="mb-8 max-w-[420px] text-on-surface-variant"
            style={{ fontSize: 16, lineHeight: 1.7 }}
          >
            Professional planning drawings, structural calculations and full
            building regs packages. From £550, 100% online, UK‑wide. Save
            £2,000–£4,000 and 8 weeks vs a traditional architect.
          </p>
          <div className="flex flex-col flex-wrap gap-4 sm:flex-row">
            <a
              href="#contact"
              className="editorial-shadow inline-block rounded bg-primary px-8 py-4 text-center text-sm font-bold uppercase tracking-widest text-on-primary transition-colors hover:bg-surface-tint"
            >
              Get Your Free Quote in 24 Hours
            </a>
            <a
              href="#process"
              className="inline-block rounded border border-outline px-8 py-4 text-center text-sm font-bold uppercase tracking-widest text-on-surface transition-colors hover:bg-surface-container-low"
            >
              See How It Works →
            </a>
            {/* Self-measurement is the product's differentiator and the
                entry point to the app, so it gets a filled accent treatment
                and a supporting line rather than sitting as a third
                identical outline button nobody reads. */}
            <Link
              href="/measure"
              className="editorial-shadow group inline-flex flex-col rounded border-2 border-primary bg-primary/10 px-8 py-4 text-left transition-colors hover:bg-primary hover:text-on-primary"
            >
              <span className="text-sm font-bold uppercase tracking-widest text-primary group-hover:text-on-primary">
                Measure it yourself →
              </span>
              <span className="mt-1 text-xs font-normal normal-case tracking-normal text-on-surface-variant group-hover:text-on-primary">
                Free app · plans start next day
              </span>
            </Link>
          </div>
          <div className="mb-2 mt-6 flex items-center gap-3">
            {/* The Google rating badge was removed.
                It read "5.0 ★★★★★ (21 reviews)" and linked to the
                Maps listing, and the reviews behind it were written
                rather than received. A rating is a claim about what
                other people said; inventing one is not a placeholder
                that gets replaced later, it is a false statement
                sitting on the page in the meantime.

                Put it back when the listing genuinely carries those
                reviews, and take the figures from the listing. */}
          </div>
          <div className="hero-stats-row">
            <div>
              <div className="stat-num">98%</div>
              <div className="stat-lbl">1st-Time Approval</div>
            </div>
            <div>
              <div className="stat-num">2wk</div>
              <div className="stat-lbl">Guaranteed</div>
            </div>
            <div>
              <div className="stat-num">£550</div>
              <div className="stat-lbl">From</div>
            </div>
            <div>
              <div className="stat-num">150+</div>
              <div className="stat-lbl">Projects Done</div>
            </div>
          </div>
        </div>

        <div className="hero-split-right">
          <div className="absolute inset-0" aria-hidden>
            {HERO_IMAGES.map((src, i) => (
              <div
                key={src}
                className={`cycle-slide ${i === active ? "active" : ""}`}
              >
                <img src={src} alt="" className="h-full w-full object-cover" />
              </div>
            ))}
          </div>
          <div className="hero-overlay" aria-hidden />
          {/* Same again: an invented rating over the photograph. */}
        </div>
      </section>

      <div className="marquee-strip">
        <div className="marquee-inner">
          {marqueeSpans}
          {marqueeSpans}
        </div>
      </div>
    </>
  );
}
