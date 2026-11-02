// Phase 0 spike (throwaway, not shipped): does team sharing work under the drive.file scope?
// See SoupScrimTracker/docs/plans/DRIVE_SYNC_AND_DIRECTORY_PLAN.md section 2.
//
//   node spike.mjs login A            sign in as account A (drive.file + email)
//   node spike.mjs login B            sign in as account B (drive.file + email)
//   node spike.mjs setup              A: create folder "SOUP Sync Spike Team", upload a1.txt, share with B (writer)
//   node spike.mjs check B            B: can it see the folder and its files? can it write into it?
//   node spike.mjs pick B             B: Google Picker (folder selection), then sign-in; prints picked ids
//   node spike.mjs add A              A: upload another file (a2.txt / a3.txt ...) into the folder
//   node spike.mjs check A            A: list the folder, read what B wrote
//
// Tokens and state are kept next to this file (.tokens-*.json, .state.json), never committed.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { exec } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const client = JSON.parse(readFileSync(join(here, "..", "google-oauth-client.json"), "utf8"));
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const tokPath = (who) => join(here, `.tokens-${who}.json`);
const statePath = join(here, ".state.json");
const state = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {});
const saveState = (s) => writeFileSync(statePath, JSON.stringify(s, null, 2));
const b64url = (buf) => buf.toString("base64url");

async function oauth(who, { pick = false } = {}) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const st = b64url(randomBytes(16));
  const result = await new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/") return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/html" }).end("<h2>SOUP spike: you can close this tab.</h2>");
      srv.close();
      if (u.searchParams.get("state") !== st) return reject(new Error("state mismatch"));
      if (u.searchParams.get("error")) return reject(new Error(u.searchParams.get("error")));
      resolve({ code: u.searchParams.get("code"), picked: u.searchParams.get("picked_file_ids"), port: srv.port });
    });
    srv.listen(0, "127.0.0.1", () => {
      srv.port = srv.address().port;
      const p = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: `http://127.0.0.1:${srv.port}`,
        response_type: "code",
        access_type: "offline",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: st,
      });
      if (pick) {
        // The Picker flow allows drive.file only, and needs prompt=consent.
        p.set("scope", FILE_SCOPE);
        p.set("prompt", "consent");
        p.set("trigger_onepick", "true");
        p.set("allow_folder_selection", "true");
        p.set("allow_multiple", "true");
      } else {
        p.set("scope", `${FILE_SCOPE} openid email`);
        p.set("prompt", "consent select_account");
      }
      const url = `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
      console.log(`Account ${who}: a browser tab opens; sign in as account ${who}.\nIf it does not open: ${url}\n`);
      if (!process.env.SPIKE_NO_OPEN) exec(`start "" "${url}"`, { shell: "cmd.exe" });
    });
    setTimeout(() => reject(new Error("timed out after 15 minutes")), 900_000).unref();
  });
  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      code: result.code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: `http://127.0.0.1:${result.port}`,
    }),
  }).then((r) => r.json());
  if (!tr.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tr)}`);
  const prev = existsSync(tokPath(who)) ? JSON.parse(readFileSync(tokPath(who), "utf8")) : {};
  let email = prev.email;
  if (tr.id_token) email = JSON.parse(Buffer.from(tr.id_token.split(".")[1], "base64url")).email;
  writeFileSync(tokPath(who), JSON.stringify({ ...tr, refresh_token: tr.refresh_token ?? prev.refresh_token, email, at: Date.now() }, null, 2));
  console.log(`Signed in as ${email ?? "(email unknown)"}; scope: ${tr.scope}`);
  return result.picked;
}

async function token(who) {
  if (!existsSync(tokPath(who))) throw new Error(`run: node spike.mjs login ${who}`);
  const t = JSON.parse(readFileSync(tokPath(who), "utf8"));
  if (Date.now() - t.at < (t.expires_in - 60) * 1000) return t.access_token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: t.refresh_token, grant_type: "refresh_token" }),
  }).then((x) => x.json());
  if (!r.access_token) throw new Error(`refresh failed: ${JSON.stringify(r)}`);
  writeFileSync(tokPath(who), JSON.stringify({ ...t, ...r, at: Date.now() }, null, 2));
  return r.access_token;
}

async function api(who, method, url, body, headers = {}) {
  const r = await fetch(url, { method, body, headers: { authorization: `Bearer ${await token(who)}`, ...headers } });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

async function upload(who, name, parent, content) {
  const boundary = "spike" + randomBytes(6).toString("hex");
  const meta = JSON.stringify({ name, parents: [parent] });
  const body = `--${boundary}\r\ncontent-type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: text/plain\r\n\r\n${content}\r\n--${boundary}--`;
  return api(who, "POST", `${UPLOAD}/files?uploadType=multipart&fields=id,name`, body, { "content-type": `multipart/related; boundary=${boundary}` });
}

const show = (label, r) => console.log(`${label}: HTTP ${r.status}`, typeof r.json === "string" ? r.json.slice(0, 200) : JSON.stringify(r.json?.error?.message ?? r.json));

const [cmd, who = "A"] = process.argv.slice(2);
const s = state();
try {
  if (cmd === "login") await oauth(who);
  else if (cmd === "pick") {
    const picked = await oauth(who, { pick: true });
    console.log(`Picked ids: ${picked ?? "(none)"}; team folder id: ${s.folderId}`);
    saveState({ ...s, [`picked${who}`]: picked });
  } else if (cmd === "setup") {
    const b = JSON.parse(readFileSync(tokPath("B"), "utf8")).email;
    if (!b) throw new Error("sign in as B first (to learn its email)");
    const f = await api("A", "POST", `${DRIVE}/files?fields=id,name`, JSON.stringify({ name: "SOUP Sync Spike Team", mimeType: "application/vnd.google-apps.folder" }), { "content-type": "application/json" });
    show("A creates folder", f);
    const a1 = await upload("A", "a1.txt", f.json.id, "written by A before sharing");
    show("A uploads a1.txt", a1);
    const sh = await api("A", "POST", `${DRIVE}/files/${f.json.id}/permissions?sendNotificationEmail=false`, JSON.stringify({ type: "user", role: "writer", emailAddress: b }), { "content-type": "application/json" });
    show(`A shares folder with ${b}`, sh);
    saveState({ ...s, folderId: f.json.id, aFiles: [a1.json.id], n: 1 });
  } else if (cmd === "add") {
    const n = (s.n ?? 1) + 1;
    const r = await upload(who, `${who.toLowerCase()}${n}.txt`, s.folderId, `written by ${who} (#${n})`);
    show(`${who} uploads ${who.toLowerCase()}${n}.txt`, r);
    saveState({ ...s, n });
  } else if (cmd === "check") {
    show(`${who} gets the folder`, await api(who, "GET", `${DRIVE}/files/${s.folderId}?fields=id,name,owners(emailAddress)`));
    const q = encodeURIComponent(`'${s.folderId}' in parents and trashed = false`);
    const l = await api(who, "GET", `${DRIVE}/files?q=${q}&fields=files(id,name,owners(emailAddress))&includeItemsFromAllDrives=true&supportsAllDrives=true`);
    show(`${who} lists the folder`, l);
    for (const f of l.json.files ?? []) {
      const c = await api(who, "GET", `${DRIVE}/files/${f.id}?alt=media`);
      console.log(`   ${f.name} (owner ${f.owners?.[0]?.emailAddress}): HTTP ${c.status} ${typeof c.json === "string" ? JSON.stringify(c.json) : ""}`);
    }
    for (const id of s.aFiles ?? []) show(`${who} reads a1.txt by id`, await api(who, "GET", `${DRIVE}/files/${id}?alt=media`));
    if (who === "B") {
      const n = (s.n ?? 1) + 1;
      show(`B writes b${n}.txt into the folder`, await upload("B", `b${n}.txt`, s.folderId, `written by B (#${n})`));
      saveState({ ...s, n });
    }
  } else console.log("commands: login A|B, setup, check A|B, pick B, add A");
} catch (e) {
  console.error(String(e?.message ?? e));
  process.exitCode = 1;
}
