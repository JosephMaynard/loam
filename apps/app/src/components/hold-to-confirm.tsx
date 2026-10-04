import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * A button that fires only after being held down for `holdMs`: a bar sweeps across while
 * it's held, letting go early cancels. Quick enough to use under pressure, hard to trigger by accident in
 * a pocket or with a stray tap. (TalkBack users double-tap and hold, which is a long press.)
 */
export function HoldToConfirm({
  disabled = false,
  holdMs = 3000,
  holdingLabel,
  label,
  onConfirm,
  tone = 'danger',
}: {
  /** `danger` (red) for destructive actions; `neutral` (green) for ones that just need deliberate intent. */
  tone?: 'danger' | 'neutral';
  disabled?: boolean;
  holdMs?: number;
  holdingLabel: string;
  label: string;
  onConfirm: () => void;
}) {
  const theme = useTheme();
  const color = tone === 'danger' ? theme.danger : theme.primary;
  const progress = useRef(new Animated.Value(0)).current;
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  const [holding, setHolding] = useState(false);

  useEffect(() => () => animation.current?.stop(), []);

  function start(): void {
    if (disabled) {
      return;
    }
    setHolding(true);
    animation.current = Animated.timing(progress, {
      toValue: 1,
      duration: holdMs,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    animation.current.start(({ finished }) => {
      if (finished) {
        setHolding(false);
        progress.setValue(0);
        onConfirm();
      }
    });
  }

  function cancel(): void {
    animation.current?.stop();
    setHolding(false);
    Animated.timing(progress, { toValue: 0, duration: 150, useNativeDriver: false }).start();
  }

  const width = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPressIn={start}
      onPressOut={cancel}
      style={[styles.button, { borderColor: color, opacity: disabled ? 0.5 : 1 }]}>
      <Animated.View style={[styles.fill, { backgroundColor: color, width }]} />
      <View style={styles.labelWrap}>
        <ThemedText type="smallBold" style={{ color }}>
          {holding ? holdingLabel : label}
        </ThemedText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    position: 'relative',
    minHeight: 56,
    borderWidth: 2,
    borderRadius: Spacing.three,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  // A bar along the bottom edge rather than a full fill, so the label always sits on one background.
  fill: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    height: 6,
  },
  labelWrap: {
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
  },
});
