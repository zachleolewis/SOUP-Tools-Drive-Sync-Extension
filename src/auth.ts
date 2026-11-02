// Google sign-in: oauthPkce in the system browser, the refresh token in Credential Manager (app.secrets, key google.refresh),
// the access token only in memory. Nothing here logs or returns a token to the UI.
import type { OAuthOptions, OAuthTokens, RefreshOptions } from "soup";
import { CLIENT_ID, CLIENT_SECRET, DRIVE_FILE_SCOPE, type Endpoints, SCOPES } from "./constants.ts";
import { DriveError } from "./errors.ts";
import type { TokenSource } from "./drive.ts";
import type { Transport } from "./transport.ts";

export const REFRESH_KEY = "google.refresh";
export const EMAIL_KEY = "google.email";

export interface AuthPorts {
  oauthPkce(o: OAuthOptions): Promise<OAuthTokens>;
  refresh(o: RefreshOptions): Promise<OAuthTokens>;
  secrets: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; delete(k: string): Promise<boolean> };
  transport: Transport;
  endpoints: Endpoints;
  now?: () => number;
}

/** The email in an ID token (we received it straight from Google over TLS, so it is read, not verified). */
export function emailFromIdToken(idToken: string | null | undefined): string | null {
  if (!idToken) return null;
  try {
    const part = idToken.split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const bin = atob(b64);
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const email = (JSON.parse(json) as { email?: unknown }).email;
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}

export class GoogleAuth implements TokenSource {
  private access: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  email: string | null = null;

  private readonly p: AuthPorts;

  constructor(p: AuthPorts) {
    this.p = p;
  }

  private now(): number {
    return (this.p.now ?? Date.now)();
  }

  /** True when a refresh token is stored (we may still find it revoked on first use). */
  async isSignedIn(): Promise<boolean> {
    return !!(await this.p.secrets.get(REFRESH_KEY));
  }

  async storedEmail(): Promise<string | null> {
    return this.email ?? (await this.p.secrets.get(EMAIL_KEY));
  }

  /** Opens the browser. Resolves with the account's email (or null when Google sent none). */
  async signIn(signal?: AbortSignal): Promise<string | null> {
    const t = await this.p.oauthPkce({
      authorizeUrl: this.p.endpoints.authorizeUrl,
      tokenUrl: this.p.endpoints.tokenUrl,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: [...SCOPES],
      extraParams: { access_type: "offline", prompt: "consent" },
      signal,
    });
    if (!t.scope.split(/\s+/).includes(DRIVE_FILE_SCOPE)) throw new DriveError("forbidden", "Google Drive access was not granted. Sign in again and keep the Drive box ticked.");
    if (!t.refreshToken) throw new DriveError("other", "Google did not allow backups to continue in the background. Sign in again.");
    await this.p.secrets.set(REFRESH_KEY, t.refreshToken);
    this.access = { token: t.accessToken, expiresAt: t.expiresAt };
    this.email = emailFromIdToken(t.idToken);
    if (this.email) await this.p.secrets.set(EMAIL_KEY, this.email);
    return this.email;
  }

  /** Revoke the refresh token at Google (best effort) and delete everything stored. Returns false when Google could not be reached. */
  async signOut(): Promise<boolean> {
    const refresh = await this.p.secrets.get(REFRESH_KEY);
    let revoked = true;
    if (refresh) {
      try {
        const res = await this.p.transport.request({
          url: this.p.endpoints.revokeUrl,
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refresh }).toString(),
        });
        // 400 means "already invalid", which is the state we want.
        revoked = res.status === 200 || res.status === 400;
      } catch {
        revoked = false;
      }
    }
    await this.p.secrets.delete(REFRESH_KEY);
    await this.p.secrets.delete(EMAIL_KEY);
    this.access = null;
    this.email = null;
    return revoked;
  }

  async getToken(): Promise<string> {
    if (this.access && this.access.expiresAt - this.now() > 60_000) return this.access.token;
    return this.refresh();
  }

  /** Always asks Google for a new access token (one request at a time). */
  refresh(): Promise<string> {
    this.inflight ??= this.doRefresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async doRefresh(): Promise<string> {
    const refreshToken = await this.p.secrets.get(REFRESH_KEY);
    if (!refreshToken) throw new DriveError("auth", "Not signed in");
    let t: OAuthTokens;
    try {
      t = await this.p.refresh({ tokenUrl: this.p.endpoints.tokenUrl, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken });
    } catch (e) {
      const code = (e as { code?: string }).code;
      // auth_failed: Google refused the refresh token (revoked, expired). Anything else is the network.
      if (code === "auth_failed" || code === "auth_denied") throw new DriveError("auth", "Google refused the stored sign-in");
      throw new DriveError("offline", "Could not reach Google to renew the sign-in");
    }
    this.access = { token: t.accessToken, expiresAt: t.expiresAt };
    if (t.refreshToken && t.refreshToken !== refreshToken) await this.p.secrets.set(REFRESH_KEY, t.refreshToken);
    const email = emailFromIdToken(t.idToken);
    if (email && email !== this.email) {
      this.email = email;
      await this.p.secrets.set(EMAIL_KEY, email);
    }
    return t.accessToken;
  }
}
