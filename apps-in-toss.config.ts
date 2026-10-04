import { defineConfig } from '@apps-in-toss/web-framework/config';

export default defineConfig({
  appName: 'movieworldcup',
  brand: {
    primaryColor: '#D4AF37',
  },
  permissions: [],
  navigationBar: {
    withBackButton: true,
    withHomeButton: false,
    withTitle: false,
    transparentBackground: false,
    theme: 'dark',
  },
  webBundleDir: 'dist',
});
