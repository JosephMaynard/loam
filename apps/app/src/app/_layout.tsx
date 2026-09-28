import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

/** The navigation theme over the LOAM palette, so the screen background behind the host UI (and under the
 * status bar) is the same warm paper / deep ink as the rest of the app rather than stock white/black. */
function navigationTheme(dark: boolean) {
  const base = dark ? DarkTheme : DefaultTheme;
  const palette = dark ? Colors.dark : Colors.light;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: palette.primary,
      background: palette.background,
      card: palette.backgroundElement,
      text: palette.text,
      border: palette.backgroundSelected,
    },
  };
}

SplashScreen.preventAutoHideAsync();

/**
 * LOAM is a single-screen host app (the embedded server + WebView live in `index.tsx`), so the root
 * layout is just a headerless Stack — no bottom tabs. The native (ember) splash is hidden once the
 * JS is up.
 */
export default function RootLayout() {
  const colorScheme = useColorScheme();

  useEffect(() => {
    SplashScreen.hideAsync().catch(() => undefined);
  }, []);

  return (
    <ThemeProvider value={navigationTheme(colorScheme === 'dark')}>
      <Stack screenOptions={{ headerShown: false }} />
    </ThemeProvider>
  );
}
