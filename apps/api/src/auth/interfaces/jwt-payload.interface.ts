export interface JwtPayload {
  sub: string;
  email: string;
  orgId: string;
  sessionId: string;
  type: 'access';
  jti?: string;
}