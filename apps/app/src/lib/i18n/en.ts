/**
 * The Android host's own interface text (the native screens: setup, menus, Emergency Reset), in English.
 * The authoritative catalog: every other language is a `Partial` of it and falls back to these strings,
 * and `t()` only accepts these keys. No em-dashes in any of it (house style).
 */
export const en = {
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.continue': 'Continue',
  'common.back': 'Back',

  'reset.menu': 'Emergency reset',
  'reset.title': 'Emergency reset',
  'reset.body':
    "Erases every message, person, picture and file on this network, on this phone, right away. Phones connected to it clear their copy too. Your settings are kept. This can't be undone.",
  'reset.hold': 'Press and hold to erase',
  'reset.holding': 'Keep holding…',
  'reset.working': 'Erasing…',
  'reset.done': 'Erased. The network has started again, empty.',
  'reset.incomplete':
    "The erase didn't fully finish, so the network is locked until it does. Close and reopen the app to finish it.",
  'reset.failed': "Couldn't erase: {error}",
} as const;

export type AppCatalog = { [K in keyof typeof en]: string };
export type AppCatalogKey = keyof typeof en;
