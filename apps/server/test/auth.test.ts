import { describe, expect, it } from 'vitest';
import { TOKEN_TTL_MS, issueToken, verifyToken } from '../src/auth.ts';

describe('guest token', () => {
  const now = 1_800_000_000_000;

  it('round-trips and expires after 30 days', () => {
    const { token, expiresAt } = issueToken('secret', 'usr_ABC', now);
    expect(expiresAt).toBe(now + TOKEN_TTL_MS);
    expect(verifyToken('secret', token, now)).toEqual({ userId: 'usr_ABC', expiresAt });
    expect(verifyToken('secret', token, expiresAt)).toBeNull();
  });

  it('rejects other secrets, tampered user ids or expiries, and malformed input', () => {
    const { token } = issueToken('secret', 'usr_ABC', now);
    const [, expiry, sig] = token.split('.');
    expect(verifyToken('other', token, now)).toBeNull();
    expect(verifyToken('secret', `usr_EVE.${expiry}.${sig}`, now)).toBeNull();
    expect(verifyToken('secret', `usr_ABC.${Number(expiry) + 1}.${sig}`, now)).toBeNull();
    for (const bad of ['', 'a.b', 'a.b.c.d', 'usr_ABC.notanumber.sig', 42, null]) expect(verifyToken('secret', bad, now)).toBeNull();
  });
});
