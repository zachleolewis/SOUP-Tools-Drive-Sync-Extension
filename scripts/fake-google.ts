// A local stand-in for Google (OAuth + Drive), for SOUP's self-test and for trying the extension without a Google account.
//
//   node --experimental-strip-types scripts/fake-google.ts --port 18080 --write "<machine folder>/drive-sync-test-endpoints.json"
//
// It prints the base address, writes the endpoints file the extension honours (loopback addresses only, see src/endpoints.ts) and
// keeps running until stopped. /__control/expire-tokens (make every access token 401) and /__control/quota?full=1 (storage full)
// and /__control/state (what Drive holds) are for the test driving it.
import { writeFileSync } from "node:fs";
import { FakeGoogle } from "../tests/support/fake-google.ts";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const g = new FakeGoogle();
if (arg("email")) g.email = arg("email")!;
await g.start(Number(arg("port") ?? 0));
const out = arg("write");
if (out) writeFileSync(out, JSON.stringify(g.endpoints, null, 2));
console.log(JSON.stringify({ base: g.base, ...g.endpoints }));
process.on("SIGINT", () => void g.stop().then(() => process.exit(0)));
