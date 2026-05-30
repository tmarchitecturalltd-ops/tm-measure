function CheckIcon({ className }: { className?: string }) {
  return (
    <span
      className={`material-symbols-outlined leading-tight text-primary ${className ?? ""}`}
    >
      check
    </span>
  );
}

export default function Pricing() {
  return (
    <section id="planning" className="bg-surface-container-low py-20">
      <div className="mx-auto max-w-[1920px] px-4 md:px-8">
        <div className="mb-10 text-center md:mb-16">
          <span className="font-label mb-4 block text-xs font-bold uppercase tracking-[0.3em] text-primary">
            TRANSPARENT PRICING
          </span>
          <h2 className="font-headline mb-4 text-3xl text-on-surface md:text-5xl">
            Simple, Fixed Fees. No Surprises.
          </h2>
          <p className="mx-auto max-w-2xl text-on-surface-variant">
            More affordable than traditional architects, with a{" "}
            <strong className="text-primary">guaranteed 2-week turnaround</strong> on
            every project.
          </p>
        </div>

        <div className="mx-auto grid max-w-6xl grid-cols-3 gap-2 md:gap-8">
          <div
            id="structural"
            className="flex flex-col rounded-xl border border-outline-variant/30 bg-surface p-3 md:p-10"
          >
            <span className="mb-6 hidden text-[10px] font-bold uppercase tracking-widest text-on-surface-variant md:block">
              STRUCTURAL WORK
            </span>
            <h3 className="font-headline mb-1 text-xs leading-tight md:mb-2 md:text-2xl">
              Structural
            </h3>
            <div className="font-headline mb-1 text-base text-primary md:mb-2 md:text-3xl">
              £550
            </div>
            <p className="mb-2 text-[10px] font-bold text-primary md:text-xs">
              ✓ 2wk Guaranteed
            </p>
            <ul className="mb-3 flex-grow space-y-1 md:mb-10 md:space-y-4">
              <li className="flex items-start gap-1 md:gap-3">
                <CheckIcon className="text-xs md:text-lg" />
                <span className="text-[10px] leading-tight md:text-sm">Walls</span>
              </li>
              <li className="flex items-start gap-1 md:gap-3">
                <CheckIcon className="text-xs md:text-lg" />
                <span className="text-[10px] leading-tight md:text-sm">Chimneys</span>
              </li>
              <li className="flex items-start gap-1 md:gap-3">
                <CheckIcon className="text-xs md:text-lg" />
                <span className="text-[10px] leading-tight md:text-sm">Loft/Boiler</span>
              </li>
              <li className="hidden items-start gap-3 md:flex">
                <CheckIcon className="text-lg" />
                <span className="text-sm">Building control ready</span>
              </li>
              <li className="hidden items-start gap-3 md:flex">
                <CheckIcon className="text-lg" />
                <span className="text-sm">Engineer signed calcs</span>
              </li>
            </ul>
            <a
              href="#contact"
              className="block w-full rounded border border-primary py-2 text-center text-[9px] font-bold uppercase tracking-widest text-primary transition-colors hover:bg-primary hover:text-on-primary md:py-4 md:text-xs"
            >
              Get Started
            </a>
          </div>

          <div className="editorial-shadow relative flex flex-col rounded-xl border border-primary bg-inverse-surface p-3 md:p-10">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-2 py-1 text-[8px] font-bold uppercase tracking-wider text-on-primary md:-top-4 md:px-4 md:text-[10px]">
              Most Popular
            </div>
            <span className="mb-6 hidden text-[10px] font-bold uppercase tracking-widest text-surface-variant md:block">
              BEST VALUE
            </span>
            <h3 className="font-headline mb-1 text-xs leading-tight text-surface md:mb-2 md:text-2xl">
              Full Pkg
            </h3>
            <div className="font-headline mb-1 text-base text-primary md:mb-2 md:text-3xl">
              £1,650
            </div>
            <p className="mb-2 text-[10px] font-bold text-primary md:text-xs">
              ✓ 2wk Guaranteed
            </p>
            <ul className="mb-3 flex-grow space-y-1 md:mb-10 md:space-y-4">
              <li className="flex items-start gap-1 md:gap-3">
                <CheckIcon className="text-xs md:text-lg" />
                <span className="text-[10px] leading-tight text-surface md:text-sm">
                  Planning
                </span>
              </li>
              <li className="flex items-start gap-1 md:gap-3">
                <CheckIcon className="text-xs md:text-lg" />
                <span className="text-[10px] leading-tight text-surface md:text-sm">
                  Structural
                </span>
              </li>
              <li className="flex items-start gap-1 md:gap-3">
                <CheckIcon className="text-xs md:text-lg" />
                <span className="text-[10px] leading-tight text-surface md:text-sm">
                  Bldg Regs
                </span>
              </li>
              <li className="hidden items-start gap-3 md:flex">
                <CheckIcon className="text-lg" />
                <span className="text-sm text-surface">Council ready</span>
              </li>
              <li className="hidden items-start gap-3 md:flex">
                <CheckIcon className="text-lg" />
                <span className="text-sm text-surface">Priority support</span>
              </li>
            </ul>
            <a
              href="#contact"
              className="block w-full rounded bg-primary py-2 text-center text-[9px] font-bold uppercase tracking-widest text-on-primary transition-colors hover:bg-surface-tint md:py-4 md:text-xs"
            >
              Get Started
            </a>
          </div>

          <div className="flex flex-col rounded-xl border border-outline-variant/30 bg-surface p-3 md:p-10">
            <span className="mb-6 hidden text-[10px] font-bold uppercase tracking-widest text-on-surface-variant md:block">
              FOR PLANNING PERMISSION
            </span>
            <h3 className="font-headline mb-1 text-xs leading-tight md:mb-2 md:text-2xl">
              Planning
            </h3>
            <div className="font-headline mb-1 text-base text-primary md:mb-2 md:text-3xl">
              £1,100
            </div>
            <p className="mb-2 text-[10px] font-bold text-primary md:text-xs">
              ✓ 2wk Guaranteed
            </p>
            <ul className="mb-3 flex-grow space-y-1 md:mb-10 md:space-y-4">
              <li className="flex items-start gap-1 md:gap-3">
                <CheckIcon className="text-xs md:text-lg" />
                <span className="text-[10px] leading-tight md:text-sm">Floor plans</span>
              </li>
              <li className="flex items-start gap-1 md:gap-3">
                <CheckIcon className="text-xs md:text-lg" />
                <span className="text-[10px] leading-tight md:text-sm">Elevations</span>
              </li>
              <li className="flex items-start gap-1 md:gap-3">
                <CheckIcon className="text-xs md:text-lg" />
                <span className="text-[10px] leading-tight md:text-sm">Extensions</span>
              </li>
              <li className="hidden items-start gap-3 md:flex">
                <CheckIcon className="text-lg" />
                <span className="text-sm">Planning submission ready</span>
              </li>
              <li className="hidden items-start gap-3 md:flex">
                <CheckIcon className="text-lg" />
                <span className="text-sm">Revisions included</span>
              </li>
            </ul>
            <a
              href="#contact"
              className="block w-full rounded border border-primary py-2 text-center text-[9px] font-bold uppercase tracking-widest text-primary transition-colors hover:bg-primary hover:text-on-primary md:py-4 md:text-xs"
            >
              Get Started
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
