import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aurum.advisor',
  appName: 'AURUM',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    url: 'https://aurum-7cm.pages.dev',
  }
};

export default config;
