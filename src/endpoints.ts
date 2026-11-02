// Google's addresses, with ONE test hook: a file `drive-sync-test-endpoints.json` in the extension's machine folder may name
// replacement addresses for a local stand-in of Google (the SOUP self-test uses it). Every address in it must be a loopback
// address (127.0.0.1, localhost or [::1]); otherwise the whole file is ignored, so it can never redirect tokens or backups to
// another host. SOUP itself only accepts an http sign-in address in a debug build started with SOUP_EXT_AUTH_ALLOW_LOOPBACK.
import { type Endpoints, GOOGLE_ENDPOINTS } from "./constants.ts";

export const TEST_ENDPOINTS_FILE = "drive-sync-test-endpoints.json";

export function isLoopbackUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return (url.protocol === "http:" || url.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The override if `text` is a complete, all-loopback set of addresses; otherwise null. */
export function parseTestEndpoints(text: string): Endpoints | null {
  try {
    const o = JSON.parse(text) as Partial<Endpoints>;
    const keys: Array<keyof Endpoints> = ["authorizeUrl", "tokenUrl", "revokeUrl", "driveUrl", "uploadUrl"];
    if (!o || !keys.every((k) => typeof o[k] === "string" && isLoopbackUrl(o[k] as string))) return null;
    return o as Endpoints;
  } catch {
    return null;
  }
}

export async function loadEndpoints(fs: { exists(p: string): Promise<boolean>; readText(p: string): Promise<string> }, machineDir: string, warn: (m: string) => void): Promise<Endpoints> {
  const path = `${machineDir.replace(/\\/g, "/")}/${TEST_ENDPOINTS_FILE}`;
  try {
    if (await fs.exists(path)) {
      const o = parseTestEndpoints(await fs.readText(path));
      if (o) {
        warn("using local test endpoints instead of Google");
        return o;
      }
      warn(`${TEST_ENDPOINTS_FILE} ignored: every address must be on 127.0.0.1, localhost or [::1]`);
    }
  } catch {
    /* no override */
  }
  return GOOGLE_ENDPOINTS;
}
