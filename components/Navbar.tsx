export default function Navbar() {
  return (
    <nav className="fixed top-0 z-50 w-full border-b border-outline-variant/20 backdrop-blur-xl transition-colors duration-300">
      <div className="mx-auto flex h-20 max-w-[1920px] items-center justify-between px-4 md:px-8">
        <div className="font-headline text-xl font-bold tracking-tighter text-on-surface">
          TM Designs Ltd
        </div>
        <div className="hidden items-center space-x-10 md:flex">
          <a
            className="font-label text-sm uppercase tracking-tight text-on-surface/70 transition-all hover:text-primary"
            href="#planning"
          >
            Pricing
          </a>
          <a
            className="font-label text-sm uppercase tracking-tight text-on-surface/70 transition-all hover:text-primary"
            href="#process"
          >
            Process
          </a>
          <a
            className="font-label text-sm uppercase tracking-tight text-on-surface/70 transition-all hover:text-primary"
            href="#reviews"
          >
            Reviews
          </a>
          <a
            className="font-label border-b border-primary pb-1 text-sm uppercase tracking-tight text-primary transition-all hover:opacity-100"
            href="#portfolio"
          >
            Portfolio
          </a>
          <a
            className="font-label text-sm uppercase tracking-tight text-on-surface/70 transition-all hover:text-primary"
            href="#contact"
          >
            Contact
          </a>
        </div>
        <a
          href="#contact"
          className="rounded bg-primary px-6 py-2.5 text-sm font-semibold uppercase tracking-wide text-on-primary transition-colors hover:bg-surface-tint"
        >
          Start Project
        </a>
      </div>
    </nav>
  );
}
