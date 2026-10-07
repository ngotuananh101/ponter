/** Subset of the public user profile returned by the login command. */
export interface UserProfile {
  id: string;
  username: string;
  email?: string | null;
  role: string;
}
