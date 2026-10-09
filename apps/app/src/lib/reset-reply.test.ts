// Tests the launcher's Emergency Reset answer (nodejs-project-template/reset-reply.js), which main.js posts
// back as `loam-emergency-reset-result`. main.js itself can't be required here (it pulls in rn-bridge at
// import time); this helper is the seam.
import { describe, expect, it } from 'vitest';

import { resetOutcome } from './emergency-reset';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetReply } = require('../../nodejs-project-template/reset-reply.js');

describe('resetReply', () => {
  it('forwards a finished reset and a handed-off key clear', () => {
    expect(resetReply({ complete: true, phase: 'key-clear-ready', keyClearRequested: true, journaled: true })).toEqual({
      ok: true,
      complete: true,
      keyClear: true,
      journaled: true,
    });
    expect(resetReply({ complete: true, journaled: false })).toEqual({
      ok: true,
      complete: true,
      keyClear: false,
      journaled: false,
    });
  });

  it('says when an incomplete wipe was not journaled, so the host screen asks for the reset again', () => {
    const reply = resetReply({ complete: false, journaled: false });
    expect(reply).toEqual({ ok: true, complete: false, keyClear: false, journaled: false });
    expect(resetOutcome(reply)).toBe('unrecorded');
  });

  it('keeps a journaled incomplete wipe on the reopen-to-finish screen', () => {
    const reply = resetReply({ complete: false, phase: 'delete-pending', journaled: true });
    expect(reply).toEqual({ ok: true, complete: false, keyClear: false, journaled: true });
    expect(resetOutcome(reply)).toBe('incomplete');
  });

  it('counts a result without the field (an older server bundle) as journaled', () => {
    expect(resetReply({ complete: false })).toEqual({ ok: true, complete: false, keyClear: false, journaled: true });
    expect(resetReply({ complete: false, phase: 'delete-pending' }).journaled).toBe(true);
    expect(resetReply(undefined)).toEqual({ ok: true, complete: false, keyClear: false, journaled: true });
    expect(resetReply(null)).toEqual({ ok: true, complete: false, keyClear: false, journaled: true });
  });

  it('treats only a literal true as complete, so a malformed result never closes LOAM as erased', () => {
    expect(resetReply({ complete: 'yes', keyClearRequested: 1 })).toEqual({
      ok: true,
      complete: false,
      keyClear: false,
      journaled: true,
    });
  });
});
