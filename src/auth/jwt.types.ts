import { Role } from '@prisma/client';

/**
 * Claims in the API JWT. Signed HS256 with JWT_SECRET, which equals the
 * website's NEXTAUTH_SECRET so NextAuth-minted and API-minted tokens are
 * mutually verifiable.
 */
export interface JwtPayload {
  sub: string; // user id
  email: string;
  role: Role;
  kycVerified: boolean;
}

/** Shape attached to req.user after the guard verifies a token. */
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  kycVerified: boolean;
}
