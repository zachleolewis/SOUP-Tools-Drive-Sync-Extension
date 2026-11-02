import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { OAuthOptions, OAuthTokens, RefreshOptions } from "soup";
import { EMAIL_KEY, GoogleAuth, REFRESH_KEY, emailFromIdToken } from "../src/auth.ts";
import { CLIENT_ID, SCOPES } from "../src/constants.ts";
import { DriveError } from "../src/errors.ts";
import { loadEndpoints, parseTestEndpoints } from "../src/endpoints.ts";
import { GOOGLE_ENDPOINTS } from "../src/constants.ts";
import { NodeTransport } from "./support/fakes.ts";
import { FakeGoogle } from "./support/fake-google.ts";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("sign-in", () => {
  let g: FakeGoogle;
  let store: Map<string, string>;
  let auth: GoogleAuth;
  let pkceCalls: OAuthOptions[];
  let now: number;

  beforeEach(async () => {
    g = await new FakeGoogle().start();
    store = new Map();
    pkceCalls = [];
    now = 1_000_000;
    const secrets = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => store.delete(k) };
    // oauthPkce/refresh as SOUP does them, talking to the fake's token endpoint (the "browser" step is the fake's /authorize redirect).
    const oauthPkce = async (o: OAuthOptions): Promise<OAuthTokens> => {
      pkceCalls.push(o);
      const verifier = "v".repeat(50);
      const { createHash } = await import("node:crypto");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      g.authorizeRequests.push({ code_challenge: challenge });
      const code = "code-x";
      (g as unknown as { codes: Map<string, { challenge: string }> }).codes.set(code, { challenge });
      const res = await fetch(o.tokenUrl, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: o.clientId }) });
      const j = (await res.json()) as { access_token: string; refresh_token?: string; scope: string; id_token?: string };
      return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresAt: now + 3_600_000, scope: j.scope, idToken: j.id_token ?? null, extra: {} };
    };
    const refresh = async (o: RefreshOptions): Promise<OAuthTokens> => {
      const res = await fetch(o.tokenUrl, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: o.refreshToken }) });
      if (!res.ok) throw Object.assign(new Error("auth_failed"), { code: "auth_failed" });
      const j = (await res.json()) as { access_token: string; scope: string; id_token?: string };
      return { accessToken: j.access_token, refreshToken: null, expiresAt: now + 3_600_000, scope: j.scope, idToken: j.id_token ?? null, extra: {} };
    };
    auth = new GoogleAuth({ oauthPkce, refresh, secrets, transport: new NodeTransport(), endpoints: g.endpoints, now: () => now });
  });
  afterEach(async () => {
    await g.stop();
  });

  test("asks for exactly drive.file, openid and email, offline access, with the consent screen forced", async () => {
    await auth.signIn();
    const o = pkceCalls[0];
    assert.deepEqual(o.scopes, ["https://www.googleapis.com/auth/drive.file", "openid", "email"]);
    assert.deepEqual([...SCOPES], o.scopes);
    assert.equal(o.clientId, CLIENT_ID);
    assert.deepEqual(o.extraParams, { access_type: "offline", prompt: "consent" });
    assert.ok(!o.scopes.some((s) => /\/auth\/drive$|drive\.readonly|drive\.metadata|drive\.appdata/.test(s)), "no broader Drive scope");
  });

  test("the refresh token goes to the secret store, the email is read from the ID token, no token is returned to the UI", async () => {
    const email = await auth.signIn();
    assert.equal(email, "tester@example.com");
    assert.match(store.get(REFRESH_KEY)!, /^rt-/);
    assert.equal(store.get(EMAIL_KEY), "tester@example.com");
    assert.equal(await auth.isSignedIn(), true);
  });

  test("a sign-in without the Drive permission, or without offline access, is refused and stores nothing", async () => {
    g.grantedScope = "openid email";
    await assert.rejects(auth.signIn(), (e) => e instanceof DriveError && /Drive access was not granted/.test(e.message));
    assert.equal(store.size, 0);
  });

  test("getToken caches the access token until a minute before it expires, then refreshes", async () => {
    await auth.signIn();
    const t1 = await auth.getToken();
    const before = g.tokenRequests.length;
    assert.equal(await auth.getToken(), t1);
    assert.equal(g.tokenRequests.length, before, "no request");
    now += 3_600_000 - 30_000; // 30 s left
    const t2 = await auth.getToken();
    assert.notEqual(t2, t1);
    assert.equal(g.tokenRequests.at(-1)!.grant_type, "refresh_token");
  });

  test("concurrent refreshes share one request", async () => {
    await auth.signIn();
    const before = g.tokenRequests.length;
    const [a, b] = await Promise.all([auth.refresh(), auth.refresh()]);
    assert.equal(a, b);
    assert.equal(g.tokenRequests.length, before + 1);
  });

  test("a revoked refresh token is 'sign in again' (auth); no network is 'offline'", async () => {
    await auth.signIn();
    g.refreshTokens.clear();
    await assert.rejects(auth.refresh(), (e) => e instanceof DriveError && e.kind === "auth");
    const offline = new GoogleAuth({
      oauthPkce: async () => { throw new Error("x"); },
      refresh: async () => { throw Object.assign(new Error("net"), { code: "transfer_failed" }); },
      secrets: { get: async () => "rt", set: async () => undefined, delete: async () => true },
      transport: new NodeTransport(),
      endpoints: g.endpoints,
    });
    await assert.rejects(offline.refresh(), (e) => e instanceof DriveError && e.kind === "offline");
    const signedOut = new GoogleAuth({ oauthPkce: async () => { throw new Error("x"); }, refresh: async () => { throw new Error("x"); }, secrets: { get: async () => null, set: async () => undefined, delete: async () => true }, transport: new NodeTransport(), endpoints: g.endpoints });
    await assert.rejects(signedOut.getToken(), (e) => e instanceof DriveError && e.kind === "auth");
  });

  test("sign out revokes the token at Google and deletes everything stored", async () => {
    await auth.signIn();
    const rt = store.get(REFRESH_KEY)!;
    const revoked = await auth.signOut();
    assert.equal(revoked, true);
    assert.deepEqual(g.revoked, [rt]);
    assert.equal(store.size, 0);
    assert.equal(await auth.isSignedIn(), false);
  });

  test("sign out still deletes the local secret when Google cannot be reached", async () => {
    await auth.signIn();
    await g.stop();
    const revoked = await auth.signOut();
    assert.equal(revoked, false);
    assert.equal(store.size, 0);
    g.stop = async () => undefined;
  });
});

describe("helpers", () => {
  test("emailFromIdToken reads the payload and survives garbage", () => {
    assert.equal(emailFromIdToken(`${b64({})}.${b64({ email: "a@b.c" })}.sig`), "a@b.c");
    assert.equal(emailFromIdToken("nonsense"), null);
    assert.equal(emailFromIdToken(null), null);
    assert.equal(emailFromIdToken(`${b64({})}.${b64({ sub: "1" })}.sig`), null);
  });

  test("test endpoints are accepted only when every address is on this PC", async () => {
    const good = { authorizeUrl: "http://127.0.0.1:5/a", tokenUrl: "http://localhost:5/t", revokeUrl: "http://127.0.0.1:5/r", driveUrl: "http://127.0.0.1:5/d", uploadUrl: "http://[::1]:5/u" };
    assert.deepEqual(parseTestEndpoints(JSON.stringify(good)), good);
    assert.equal(parseTestEndpoints(JSON.stringify({ ...good, driveUrl: "https://evil.example.com/d" })), null, "one remote address voids the file");
    assert.equal(parseTestEndpoints(JSON.stringify({ ...good, tokenUrl: "http://127.0.0.1.evil.com/t" })), null);
    assert.equal(parseTestEndpoints(JSON.stringify({ ...good, uploadUrl: undefined })), null);
    assert.equal(parseTestEndpoints("not json"), null);

    const warns: string[] = [];
    const fsWith = (text: string | null) => ({ exists: async () => text !== null, readText: async () => text! });
    assert.deepEqual(await loadEndpoints(fsWith(null), "C:\\m", (m) => warns.push(m)), GOOGLE_ENDPOINTS);
    assert.deepEqual(await loadEndpoints(fsWith(JSON.stringify(good)), "C:\\m", (m) => warns.push(m)), good);
    assert.deepEqual(await loadEndpoints(fsWith(JSON.stringify({ ...good, driveUrl: "https://evil.example.com" })), "C:\\m", (m) => warns.push(m)), GOOGLE_ENDPOINTS);
    assert.equal(warns.length, 2);
  });

  test("the shipped endpoints are Google's, over https", () => {
    for (const u of Object.values(GOOGLE_ENDPOINTS)) assert.match(u, /^https:\/\/(accounts\.google\.com|oauth2\.googleapis\.com|www\.googleapis\.com)\//);
  });
});
