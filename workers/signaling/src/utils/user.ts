import type { UserSelect } from '../db/schema';

/**
 * Projection of a `users` row that is safe to return over the API.
 *
 * `passwordHash` and the internal `metadata` column are deliberately omitted,
 * so a row must never be serialised wholesale. Every route that returns a user
 * goes through this helper to keep the projection in one place.
 */
export type PublicUser = {
  id: string;
  username: string;
  email: string | null;
  publicKey: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

export function toPublicUser(user: UserSelect): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    publicKey: user.publicKey,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
}
