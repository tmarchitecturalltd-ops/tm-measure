import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "TM Measure | Self-measurement",
  description:
    "Submit room dimensions, photos, and notes for your TM Designs project — guided intake aligned with TM Measure (web manual mode).",
};

export default function MeasureLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
