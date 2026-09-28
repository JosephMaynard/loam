/**
 * The host app's colours, light and dark — the LOAM palette the web client uses (warm paper, ink, moss
 * green, ember orange), so the native top bar, menus and overlays sit naturally around the WebView.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#1d2622',
    background: '#f3f0e8',
    backgroundElement: '#faf9f5',
    backgroundSelected: '#e6e1d6',
    textSecondary: '#5b6862',
    /** Ember: the selected segment of a choice (e.g. the share screen's Hotspot / Wi-Fi control). */
    accent: '#f26b1d',
    /** Ink on `accent`: dark in both schemes (white on this orange is ~3:1, too faint for small text). */
    onAccent: '#1d2622',
    /** Moss green: borders and emphasis. */
    primary: '#2f5f4c',
  },
  dark: {
    text: '#e9ebe6',
    background: '#111412',
    backgroundElement: '#171b18',
    backgroundSelected: '#263a30',
    textSecondary: '#a3aca6',
    accent: '#f26b1d',
    onAccent: '#1d2622',
    primary: '#3a745b',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
