import type { NextConfig } from "next";

const isCapacitorExport = process.env.CAPACITOR === "1";

const nextConfig: NextConfig = {
  output: isCapacitorExport ? "export" : undefined,
  images: { unoptimized: isCapacitorExport },
  transpilePackages: [
    "@tm-designs/measure-core",
    "@tm-designs/capacitor-roomplan",
  ],
};

export default nextConfig;
