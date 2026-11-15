"use client";

/**
 * components/InternalHome.tsx
 *
 * The front door of the hosted tools.
 *
 * Built on the marketing hero's layout on purpose: the split, the
 * photographs cycling on the right, the typography. It is the same
 * company and there is no reason for the internal side to look like
 * a different, worse product.
 *
 * What is gone is everything that sells. No "Get your free quote",
 * no price, no 98% approval statistic, no process diagram, no
 * portfolio, no contact form. Those are claims aimed at a customer,
 * and nobody behind this login is one — the page sat half sales
 * site and half toolbox, which is exactly how it read.
 *
 * In their place, the four tools. Which is the only question anyone
 * opening this page is actually asking.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

const IMAGES = [
  "https://images.pexels.com/photos/1396122/pexels-photo-1396122.jpeg?auto=compress&cs=tinysrgb&w=1400&h=1000&fit=crop",
  "https://images.pexels.com/photos/2724749/pexels-photo-2724749.jpeg?auto=compress&cs=tinysrgb&w=1400&h=1000&fit=crop",
  "https://images.pexels.com/photos/1115804/pexels-photo-1115804.jpeg?auto=compress&cs=tinysrgb&w=1400&h=1000&fit=crop",
  "https://images.pexels.com/photos/323780/pexels-photo-323780.jpeg?auto=compress&cs=tinysrgb&w=1400&h=1000&fit=crop",
  "https://images.pexels.com/photos/1029599/pexels-photo-1029599.jpeg?auto=compress&cs=tinysrgb&w=1400&h=1000&fit=crop",
];

const TOOLS = [
  {
    href: "/measure",
    title: "Survey",
    body: "The customer's measuring flow. Scan or type a room, then send it.",
  },
  {
    href: "/architect",
    title: "Submissions",
    body: "Every survey that has come in. Open one to check it and approve.",
  },
  {
    href: "/architect/proposal",
    title: "Proposal tool",
    body: "Draw a rear extension on a survey. Rules, loads and a DXF.",
  },
  {
    href: "/status",
    title: "Status",
    body: "What a customer sees when they look up their submission.",
  },
];

export default function InternalHome() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const id = window.setInterval(
      () => setActive((i) => (i + 1) % IMAGES.length),
      5000,
    );
    return () => window.clearInterval(id);
  }, []);

  return (
    <section className="hero-split">
      <div className="hero-split-left">
        {/* The company name, because a page with no mark on it
            looks like a page that is half finished -- and because
            on a phone the photograph is above the fold and this is
            the only thing identifying where you are. */}
        <div className="font-headline mb-6 text-xl font-bold tracking-tighter text-on-surface">
          TM Designs Ltd
        </div>
        <div className="eyebrow-line">Internal</div>
        <h1
          className="font-headline mb-6 text-on-surface"
          style={{
            fontSize: "clamp(2.2rem, 3.6vw, 3.6rem)",
            lineHeight: 1.05,
            letterSpacing: "-0.02em",
          }}
        >
          TM Measure tools
        </h1>

        <div className="grid gap-3 sm:grid-cols-2">
          {TOOLS.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="tm-lift rounded-2xl border border-outline-variant/40 bg-surface-container-low p-5"
            >
              <p className="font-headline text-lg text-on-surface">{t.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-on-surface-variant">
                {t.body}
              </p>
              <p className="mt-3 text-sm font-bold text-primary">Open &rarr;</p>
            </Link>
          ))}
        </div>

        <p className="mt-6 text-xs text-on-surface-variant">
          Not for customers. The public site is tmdesignsltd.com and is
          served separately.
        </p>
      </div>

      <div className="hero-split-right">
        <div className="absolute inset-0" aria-hidden>
          {IMAGES.map((src, i) => (
            <div
              key={src}
              className={`cycle-slide ${i === active ? "active" : ""}`}
            >
              <img src={src} alt="" className="h-full w-full object-cover" />
            </div>
          ))}
        </div>
        <div className="hero-overlay" aria-hidden />
      </div>
    </section>
  );
}
