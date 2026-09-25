import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/utils/crypto';
import {
  signAccessToken,
  signRefreshToken,
  verifyToken,
} from '../src/utils/jwt';

describe('Crypto & JWT Utilities', () => {
  describe('Password Hashing', () => {
    it('hashes and verifies password correctly', async () => {
      const password = 'SuperSecretPassword123!';
      const hash = await hashPassword(password);
      expect(hash).toMatch(
        /^\$pbkdf2\$v=1\$i=100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/,
      );

      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);

      const isInvalid = await verifyPassword('WrongPassword', hash);
      expect(isInvalid).toBe(false);
    });

    it('rejects tampered hash string format gracefully', async () => {
      const isValid = await verifyPassword('password', 'invalid-hash-string');
      expect(isValid).toBe(false);
    });
  });

  describe('JWT Tokens', () => {
    const accessSecret = 'access-test-secret-at-least-32-chars-long';
    const refreshSecret = 'refresh-test-secret-at-least-32-chars-long';

    it('signs and verifies access token', async () => {
      const { token, jti, exp } = await signAccessToken(
        'usr_1',
        'alice',
        accessSecret,
        900,
      );
      expect(token).toBeDefined();
      expect(jti).toBeDefined();
      expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

      const payload = await verifyToken(token, accessSecret);
      expect(payload.sub).toBe('usr_1');
      expect(payload.username).toBe('alice');
      expect(payload.type).toBe('access');
      expect(payload.jti).toBe(jti);
    });

    it('signs and verifies refresh token', async () => {
      const { token, jti } = await signRefreshToken(
        'usr_1',
        refreshSecret,
        604800,
      );
      const payload = await verifyToken(token, refreshSecret);
      expect(payload.sub).toBe('usr_1');
      expect(payload.type).toBe('refresh');
      expect(payload.jti).toBe(jti);
    });

    it('fails verification on tampered token or wrong secret', async () => {
      const { token } = await signAccessToken('usr_1', 'alice', accessSecret);
      await expect(
        verifyToken(token, 'wrong-secret-32-characters-minimum'),
      ).rejects.toThrow();
      await expect(
        verifyToken(token + 'tampered', accessSecret),
      ).rejects.toThrow();
    });
  });
});
