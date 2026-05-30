import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.tmdesigns.portal",
  appName: "TM Designs Portal",
  webDir: "out",
  server: {
    androidScheme: "https",
  },
};

export default config;
