// The slice of React Native's `Alert.alert` the confirmation helpers use, injected so they stay testable in
// the node-only Vitest harness (tests pass a mock and press its buttons). `Alert.alert` itself satisfies it.

export type ShowAlertButton = {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
};

export type ShowAlert = (title: string, message?: string, buttons?: ShowAlertButton[]) => void;
