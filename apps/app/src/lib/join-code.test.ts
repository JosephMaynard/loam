import { describe, expect, it } from 'vitest';

import { parseScannedCode, parseTypedAddress } from './join-code';

describe('parseScannedCode', () => {
  it('reads another node’s join code: its origin and the key to pin, ignoring an invite code', () => {
    expect(parseScannedCode('http://10.80.217.150:3000/#k=abc_DEF-123&i=INVITE')).toEqual({
      kind: 'loam',
      url: 'http://10.80.217.150:3000',
      transportKey: 'abc_DEF-123',
    });
    expect(parseScannedCode('http://192.168.1.5:3000/channels?x=1')).toEqual({ kind: 'loam', url: 'http://192.168.1.5:3000' });
  });

  it('recognises the hotspot Wi-Fi code, escapes included', () => {
    expect(parseScannedCode('WIFI:T:WPA;S:LOAM\\;camp;P:secret;;')).toEqual({ kind: 'wifi', ssid: 'LOAM;camp' });
  });

  it('refuses anything else, and drops a malformed key', () => {
    for (const data of ['hello', 'mailto:a@b.c', 'ftp://1.2.3.4/', 'http://user:pw@1.2.3.4:3000/']) {
      expect(parseScannedCode(data)).toEqual({ kind: 'other' });
    }
    expect(parseScannedCode('http://1.2.3.4:3000/#k=bad key')).toEqual({ kind: 'loam', url: 'http://1.2.3.4:3000' });
  });
});

describe('parseTypedAddress', () => {
  it('accepts a bare address (default port) or a full URL', () => {
    expect(parseTypedAddress(' 192.168.4.1 ')).toEqual({ url: 'http://192.168.4.1:3000' });
    expect(parseTypedAddress('192.168.4.1:8080')).toEqual({ url: 'http://192.168.4.1:8080' });
    expect(parseTypedAddress('http://10.0.0.2:3000/')).toEqual({ url: 'http://10.0.0.2:3000' });
    expect(parseTypedAddress('')).toBeUndefined();
    expect(parseTypedAddress('not an address at all')).toBeUndefined();
  });
});
