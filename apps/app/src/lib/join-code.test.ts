import { describe, expect, it } from 'vitest';

import { parseScannedCode } from './join-code';

const KEY = 'abc_DEF-123';
const CODE = 'ABCDEFGHIJKLMNOP';

describe('parseScannedCode', () => {
  it('reads a link code: the node’s origin, its key and the code, ignoring anything else', () => {
    expect(parseScannedCode(`http://10.80.217.150:3000/#k=${KEY}&l=${CODE}`)).toEqual({
      kind: 'link',
      url: 'http://10.80.217.150:3000',
      transportKey: KEY,
      linkCode: CODE,
    });
    expect(parseScannedCode(`http://192.168.1.5:3000/channels?x=1#l=${CODE}&k=${KEY}`)).toMatchObject({
      kind: 'link',
      url: 'http://192.168.1.5:3000',
    });
  });

  it('tells an ordinary join code (for people) apart, invite code or not', () => {
    expect(parseScannedCode(`http://10.0.0.5:3000/#k=${KEY}`)).toEqual({ kind: 'join' });
    expect(parseScannedCode(`http://10.0.0.5:3000/#k=${KEY}&i=INVITE`)).toEqual({ kind: 'join' });
    expect(parseScannedCode('http://10.0.0.5:3000/')).toEqual({ kind: 'join' });
  });

  it('refuses a link code without a key or with a malformed code', () => {
    expect(parseScannedCode(`http://10.0.0.5:3000/#l=${CODE}`)).toEqual({ kind: 'other' });
    expect(parseScannedCode(`http://10.0.0.5:3000/#k=${KEY}&l=short`)).toEqual({ kind: 'other' });
  });

  it('recognises the hotspot Wi-Fi code, escapes included', () => {
    expect(parseScannedCode('WIFI:T:WPA;S:LOAM\\;camp;P:secret;;')).toEqual({ kind: 'wifi', ssid: 'LOAM;camp' });
  });

  it('refuses anything else', () => {
    for (const data of ['hello', 'mailto:a@b.c', 'ftp://1.2.3.4/', `http://user:pw@1.2.3.4:3000/#k=${KEY}&l=${CODE}`]) {
      expect(parseScannedCode(data)).toEqual({ kind: 'other' });
    }
  });
});
