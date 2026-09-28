import type { UserSelect } from './db/schema.js';
import type { Database } from './db/client.js';

export interface AppEnv {
  DATABASE_PATH: string;
  JWT_SECRET: string;
  REFRESH_TOKEN_SECRET: string;
  JWT_EXPIRES_IN?: string;
  REFRESH_TOKEN_EXPIRES_IN?: string;
  PORT?: number;
  CORS_ORIGIN?: string;
  TURN_SECRET?: string;
  TURN_URL?: string;
  STUN_URL?: string;
}

export type Variables = {
  user: UserSelect;
  tokenPayload: {
    sub: string;
    username?: string;
    jti: string;
    type: string;
    exp: number;
  };
  db: Database;
};

export type AppContext = {
  Variables: Variables;
};
