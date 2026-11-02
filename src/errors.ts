export type DriveErrorKind =
  | "auth" // 401 after one refresh, or the refresh token is gone: sign in again
  | "quota" // 403 storageQuotaExceeded
  | "forbidden" // other 403
  | "notfound"
  | "rate" // 429 (after the backoff)
  | "server" // 5xx (after the backoff)
  | "offline" // the request did not reach Google
  | "other";

export class DriveError extends Error {
  readonly kind: DriveErrorKind;
  readonly status: number;
  constructor(kind: DriveErrorKind, message: string, status = 0) {
    super(message);
    this.name = "DriveError";
    this.kind = kind;
    this.status = status;
  }
}

export class CancelError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelError";
  }
}

export function isCancel(e: unknown): boolean {
  return e instanceof CancelError || (e instanceof Error && e.name === "CancelError");
}

/** What the person reads (a Notice, the status line). Never contains a token. */
export function userMessage(e: unknown): string {
  if (isCancel(e)) return "Cancelled";
  if (e instanceof DriveError) {
    switch (e.kind) {
      case "auth": return "Google sign-in has expired. Sign in again.";
      case "quota": return "Your Google Drive is full.";
      case "forbidden": return "Google refused the request (no access).";
      case "offline": return "Can't reach Google. It will try again later.";
      case "rate": return "Google is busy right now. It will try again later.";
      case "server": return "Google had a problem. It will try again later.";
      case "notfound": return "A file or folder was not found in Google Drive.";
      default: return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

/** Errors a retry in the next scheduled run can fix (or that mean the whole run is pointless right now). */
export function isRunFatal(e: unknown): boolean {
  return e instanceof DriveError && ["auth", "quota", "offline", "rate", "server", "forbidden"].includes(e.kind);
}
