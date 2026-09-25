import { sign, verify } from 'hono/jwt';

export interface TokenPayload {
  sub: string;
  username?: string;
  type: 'access' | 'refresh';
  jti: string;
  exp: number;
  [key: string]: unknown;
}

export async function signAccessToken(
  userId: string,
  username: string,
  secret: string,
  expiresInSeconds = 900, // 15 mins
): Promise<{ token: string; jti: string; exp: number }> {
  const jti = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload: TokenPayload = {
    sub: userId,
    username,
    type: 'access',
    jti,
    exp,
  };

  const token = await sign(payload, secret);
  return { token, jti, exp };
}

export async function signRefreshToken(
  userId: string,
  secret: string,
  expiresInSeconds = 604800, // 7 days
): Promise<{ token: string; jti: string; exp: number }> {
  const jti = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload: TokenPayload = {
    sub: userId,
    type: 'refresh',
    jti,
    exp,
  };

  const token = await sign(payload, secret);
  return { token, jti, exp };
}

export async function verifyToken(
  token: string,
  secret: string,
): Promise<TokenPayload> {
  const payload = (await verify(
    token,
    secret,
    'HS256',
  )) as unknown as TokenPayload;
  return payload;
}
