import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aurum.advisor',
  appName: 'AURUM',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  }
};

export default config;
