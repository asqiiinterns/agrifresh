import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.agrifresh.app",
  appName: "AgriFresh",
  webDir: "dist",
  server: {
    androidScheme: "https"
  }
};

export default config;
