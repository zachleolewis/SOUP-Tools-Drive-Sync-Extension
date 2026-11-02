// Google OAuth "Desktop app" client of the Google Cloud project soup-tools. A desktop client's secret is public by design
// (Google: https://developers.google.com/identity/protocols/oauth2/native-app); PKCE is the protection, and the released main.js
// contains it. It is still kept out of git: GitHub reports Google client secrets pushed to public repositories, and Google may
// then disable the client. The build fills these in (vite.config.ts: DRIVE_SYNC_CLIENT_ID / DRIVE_SYNC_CLIENT_SECRET, or the
// git-ignored google-oauth-client.json); tests and an unconfigured build get placeholders that Google would refuse.
declare const __DRIVE_SYNC_CLIENT_ID__: string | undefined;
declare const __DRIVE_SYNC_CLIENT_SECRET__: string | undefined;
export const CLIENT_ID: string = typeof __DRIVE_SYNC_CLIENT_ID__ === "string" ? __DRIVE_SYNC_CLIENT_ID__ : "unconfigured.apps.googleusercontent.com";
export const CLIENT_SECRET: string = typeof __DRIVE_SYNC_CLIENT_SECRET__ === "string" ? __DRIVE_SYNC_CLIENT_SECRET__ : "unconfigured";

/** The ONLY scopes this extension ever asks for. Do not add others (drive.file is non-sensitive; the broad drive scope is not). */
export const SCOPES = ["https://www.googleapis.com/auth/drive.file", "openid", "email"] as const;
export const DRIVE_FILE_SCOPE = SCOPES[0];

export interface Endpoints {
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  /** Drive API v3 base, no trailing slash. */
  driveUrl: string;
  /** Drive upload API v3 base, no trailing slash. */
  uploadUrl: string;
}

export const GOOGLE_ENDPOINTS: Endpoints = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  driveUrl: "https://www.googleapis.com/drive/v3",
  uploadUrl: "https://www.googleapis.com/upload/drive/v3",
};

export const ROOT_FOLDER_NAME = "SOUP Sync";
export const BACKUPS_FOLDER_NAME = "Backups";
export const LIBRARY_FOLDER_NAME = "library";
export const SETTINGS_FILE_NAME = "settings.soupprofile";
export const BACKUP_JSON_NAME = "backup.json";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Files above this go through a resumable upload; smaller ones in one multipart request. */
export const RESUMABLE_THRESHOLD = 5 * 1024 * 1024;
/** Resumable chunk size: a multiple of 256 KiB, as Drive requires. */
export const CHUNK_SIZE = 8 * 1024 * 1024;
export const CHUNK_QUANTUM = 256 * 1024;

export const TOMBSTONE_DAYS = 30;
export const DEBOUNCE_MS = 2 * 60 * 1000;
export const DEFAULT_INTERVAL_HOURS = 24;
export const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;
export const LIVE_RECHECK_MS = 5 * 60 * 1000;
export const MAX_TRIES = 5;
export const BACKUP_FORMAT = 1;
