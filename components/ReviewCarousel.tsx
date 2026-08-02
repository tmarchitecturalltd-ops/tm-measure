"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type Review = {
  initial: string;
  name: string;
  quote: string;
  meta: string;
};

const REVIEWS: Review[] = [
  {
    initial: "J",
    name: "James Okafor",
    quote:
      "Extremely professional and fast. TM Architectural Designs delivered our planning drawings well within the 2-week window. Council approved first time — couldn't ask for more.",
    meta: "Google Review · TM Architectural Designs LTD · 1 week ago",
  },
  {
    initial: "S",
    name: "Sarah Mitchell",
    quote:
      "I needed structural calculations for a chimney breast removal. TM were responsive, affordable and the drawings were accepted by building control without any queries. Great service.",
    meta: "Google Review · TM Architectural Designs LTD · 2 weeks ago",
  },
  {
    initial: "A",
    name: "Adam Harrison",
    quote:
      "TM Designs provided their services much faster than any other architect I'd been quoted. Took a huge amount of stress out of my home extension project. Highly recommend.",
    meta: "Google Review · TM Architectural Designs LTD · 1 month ago",
  },
  {
    initial: "L",
    name: "Louise Bennett",
    quote:
      "Professional, creative and detail-oriented. Their drawings transformed our vision into something buildable and beautiful. The whole process was completely seamless.",
    meta: "Google Review · TM Architectural Designs LTD · 1 month ago",
  },
  {
    initial: "P",
    name: "Priya Sharma",
    quote:
      "Used TM for our loft conversion drawings. Very clear communication throughout, revisions were handled quickly, and the final package was exactly what building control needed.",
    meta: "Google Review · TM Architectural Designs LTD · 3 months ago",
  },
  {
    initial: "O",
    name: "Oliver Knight",
    quote:
      "Outstanding. Smart, well-structured drawings that helped us secure planning approval faster and for significantly less than a traditional architect. Done in under 2 weeks.",
    meta: "Google Review · TM Architectural Designs LTD · 2 months ago",
  },
  {
    initial: "M",
    name: "Marcus Webb",
    quote:
      "Brilliant service for our single-storey extension. Everything was remote — they worked from photos and measurements I sent. Back in under 2 weeks, approved by the council. Excellent value.",
    meta: "Google Review · TM Architectural Designs LTD · 4 months ago",
  },
  {
    initial: "D",
    name: "Daniel Cooper",
    quote:
      "Used TM for a rear extension and loft conversion package. Both sets of drawings were thorough and building control signed off without any issues. Really impressed.",
    meta: "Verified Google Review · TM Architectural Designs LTD",
  },
  {
    initial: "R",
    name: "Rachel Thompson",
    quote:
      "Amazing turnaround time. We needed planning drawings urgently and TM delivered in just over a week. The quality was exceptional for the price.",
    meta: "Verified Google Review · TM Architectural Designs LTD",
  },
  {
    initial: "M",
    name: "Michael Patel",
    quote:
      "Third time using TM Designs and they never disappoint. This time for a garage conversion — drawings were perfect and council approved within days.",
    meta: "Verified Google Review · TM Architectural Designs LTD",
  },
  {
    initial: "E",
    name: "Emma Griffiths",
    quote:
      "Couldn't believe how easy the whole process was. Sent measurements, got professional drawings back in 10 days. Planning approved first time. Fantastic service.",
    meta: "Verified Google Review · TM Architectural Designs LTD",
  },
  {
    initial: "D",
    name: "David Chen",
    quote:
      "Had quotes from three local architects ranging from £3,000-£5,000. TM delivered the same quality for a fraction of the cost. No site visit needed either.",
    meta: "Verified Google Review · TM Architectural Designs LTD",
  },
  {
    initial: "H",
    name: "Helen Murphy",
    quote:
      "TM handled our double-storey extension plans brilliantly. The structural calculations were thorough and our builder said they were some of the clearest he'd seen.",
    meta: "Verified Google Review · TM Architectural Designs LTD",
  },
  {
    initial: "T",
    name: "Tom Richards",
    quote:
      "Quick, professional and great value. Used them for structural calcs on a load-bearing wall removal. Building control approved everything first time.",
    meta: "Verified Google Review · TM Architectural Designs LTD",
  },
  {
    initial: "S",
    name: "Sophie Turner",
    quote:
      "Excellent experience from start to finish. The measuring kit made everything simple and the final drawings were detailed and professional. Highly recommend.",
    meta: "Verified Google Review · TM Architectural Designs LTD",
  },
  {
    initial: "B",
    name: "Ben Walker",
    quote:
      "We used TM for our orangery plans. The drawings captured exactly what we wanted and planning went through without a hitch. Will definitely use again.",
    meta: "Verified Google Review · TM Architectural Designs LTD",
  },
  {
    initial: "K",
    name: "Kate Williams",
    quote:
      "Fast, affordable and high quality. What more could you ask for? Our loft conversion plans were delivered ahead of schedule.",
    meta: "Verified Google Review · TM Architectural Designs LTD",
  },
  {
    initial: "C",
    name: "Chris Morgan",
    quote:
      "TM Designs made the whole process stress-free. Great communication, fair pricing, and the drawings were accepted by building control immediately.",
    meta: "Verified Google Review · TM Architectural Designs LTD",
  },
  {
    initial: "N",
    name: "Natalie Brown",
    quote:
      "Needed structural calcs for a chimney removal. Quick quote, fast delivery, and my builder was very happy with the level of detail. Top service.",
    meta: "Verified Google Review · TM Architectural Designs LTD",
  },
  {
    initial: "A",
    name: "Andrew Scott",
    quote:
      "Used TM for a side return extension. Plans were clear, professional and building regs approved first submission. Saved us thousands compared to a local architect.",
    meta: "Verified Google Review · TM Architectural Designs LTD",
  },
  {
    initial: "L",
    name: "Lisa Taylor",
    quote:
      "Fantastic company. From initial enquiry to receiving our completed plans took less than 2 weeks. The whole experience was smooth and professional.",
    meta: "Verified Google Review · TM Architectural Designs LTD",
  },
];

function Stars() {
  return (
    <div className="flex text-primary">
      {Array.from({ length: 5 }).map((_, i) => (
        <span key={i} className="material-symbols-outlined text-xs">
          star
        </span>
      ))}
    </div>
  );
}

function getVisibleCount(width: number) {
  return width < 768 ? 1 : 3;
}

export default function ReviewCarousel() {
  const [pos, setPos] = useState(0);
  const [cardWidth, setCardWidth] = useState(0);
  const [viewport, setViewport] = useState(1200);
  const firstCardRef = useRef<HTMLDivElement>(null);

  const visible = getVisibleCount(viewport);
  const maxPos = Math.max(0, REVIEWS.length - visible);
  const dotCount = Math.max(1, REVIEWS.length - visible + 1);

  const goTo = useCallback(
    (idx: number) => {
      setPos(Math.max(0, Math.min(idx, maxPos)));
    },
    [maxPos],
  );

  const move = useCallback(
    (dir: number) => {
      setPos((p) => Math.max(0, Math.min(p + dir, maxPos)));
    },
    [maxPos],
  );

  useLayoutEffect(() => {
    const measure = () => {
      setViewport(window.innerWidth);
      const el = firstCardRef.current;
      if (!el) return;
      const gap = 24;
      setCardWidth(el.offsetWidth + gap);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    setPos((p) => Math.min(p, maxPos));
  }, [maxPos]);

  useEffect(() => {
    // 2.2s per slide. The previous 4s felt static on a phone, where only
    // one card is visible at a time and there's nothing else moving.
    const id = window.setInterval(() => {
      setPos((p) => (p >= maxPos ? 0 : p + 1));
    }, 2200);
    return () => window.clearInterval(id);
  }, [maxPos]);

  const offset = cardWidth > 0 ? pos * cardWidth : 0;

  return (
    <section id="reviews" className="bg-surface py-20">
      <div className="mx-auto max-w-[1920px] px-4 md:px-8">
        <div className="mb-0">
          <span className="font-label mb-4 block text-xs font-bold uppercase tracking-[0.3em] text-primary">
            CLIENT TESTIMONIALS
          </span>
          <div className="mb-12 flex flex-col justify-between gap-6 md:flex-row md:items-end">
            <h2 className="font-headline text-3xl text-on-surface md:text-5xl">
              What Our Clients Say
            </h2>
            <div className="flex items-center gap-6 rounded-lg border border-outline-variant/30 bg-surface-container-low px-6 py-4">
              <div className="flex flex-col">
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-headline text-lg font-bold tracking-tight">
                    Google
                  </span>
                  <span className="text-[9px] font-bold uppercase tracking-widest text-on-surface-variant">
                    Rating
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-bold leading-none text-primary">
                    5.0
                  </span>
                  <Stars />
                  <span className="text-[9px] font-medium uppercase tracking-widest text-on-surface-variant">
                    (21 reviews)
                  </span>
                </div>
              </div>
              <div className="h-8 w-px bg-outline-variant/30" />
              <a
                className="font-label flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.1em] text-primary transition-opacity hover:opacity-70"
                href="https://search.google.com/local/writereview?placeid=ChIJm7bjWDgFdkgRqI0-flh49kE"
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="material-symbols-outlined text-sm">
                  edit_note
                </span>
                Leave Review
              </a>
            </div>
          </div>
        </div>

        <div className="relative" id="reviews-carousel-wrapper">
          <button
            type="button"
            aria-label="Previous reviews"
            onClick={() => move(-1)}
            className="absolute left-0 top-1/2 z-10 flex h-10 w-10 -translate-x-4 -translate-y-1/2 items-center justify-center rounded-full border border-outline-variant/30 bg-surface shadow transition-colors hover:bg-primary hover:text-on-primary"
          >
            <span className="material-symbols-outlined text-sm">chevron_left</span>
          </button>
          <button
            type="button"
            aria-label="Next reviews"
            onClick={() => move(1)}
            className="absolute right-0 top-1/2 z-10 flex h-10 w-10 translate-x-4 -translate-y-1/2 items-center justify-center rounded-full border border-outline-variant/30 bg-surface shadow transition-colors hover:bg-primary hover:text-on-primary"
          >
            <span className="material-symbols-outlined text-sm">chevron_right</span>
          </button>

          <div className="overflow-hidden px-1">
            <div
              className="reviews-track"
              style={{ transform: `translateX(-${offset}px)` }}
            >
              {REVIEWS.map((r, i) => (
                <div
                  key={`${r.name}-${i}`}
                  ref={i === 0 ? firstCardRef : undefined}
                  className="review-card editorial-shadow flex-shrink-0 rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-8"
                >
                  <div className="mb-6 flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                      {r.initial}
                    </div>
                    <div>
                      <div className="text-xs font-bold uppercase tracking-widest">
                        {r.name}
                      </div>
                      <Stars />
                    </div>
                  </div>
                  <p className="mb-4 text-sm italic leading-relaxed text-on-surface">
                    &ldquo;{r.quote}&rdquo;
                  </p>
                  <div className="text-[9px] uppercase tracking-widest text-on-surface-variant">
                    {r.meta}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-8 flex justify-center gap-2" id="carousel-dots">
            {Array.from({ length: dotCount }).map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Go to review page ${i + 1}`}
                onClick={() => goTo(i)}
                className={`h-2 w-2 rounded-full transition-colors ${
                  i === pos ? "bg-primary" : "bg-outline-variant"
                }`}
              />
            ))}
          </div>
        </div>

        <div className="mt-10 text-center">
          <a
            className="inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant transition-colors hover:text-primary"
            href="https://maps.app.goo.gl/vuZ1J5rqnVh9MPFM6"
            target="_blank"
            rel="noopener noreferrer"
          >
            View all 21 reviews on Google Maps{" "}
            <span className="material-symbols-outlined text-sm">open_in_new</span>
          </a>
        </div>
      </div>
    </section>
  );
}
