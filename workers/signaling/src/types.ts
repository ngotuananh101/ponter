import type { UserSelect } from './db/schema';
import type { TokenPayload } from './utils/jwt';

export type Bindings = {
  ENVIRONMENT: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  REFRESH_TOKEN_SECRET: string;
  REFRESH_TOKEN_EXPIRES_IN: string;
  DB: D1Database;
  CACHE: KVNamespace;
};

export type Variables = {
  user: UserSelect;
  tokenPayload: TokenPayload;
};

export type AppContext = {
  Bindings: Bindings;
  Variables: Variables;
};
