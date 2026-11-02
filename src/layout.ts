// Where things live in Drive:  SOUP Sync / Backups / <profile name> (<profile id first 8>) / { library/, settings.soupprofile, backup.json }
// Folder ids are remembered between runs and checked each time; a missing one is found again by name (or, for the profile folder, by the
// profile id stored on it, which survives a rename), otherwise created.
import { BACKUPS_FOLDER_NAME, LIBRARY_FOLDER_NAME, ROOT_FOLDER_NAME } from "./constants.ts";
import type { DriveClient } from "./drive.ts";

export interface DriveFolders {
  root: string;
  backups: string;
  profile: string;
  library: string;
}

export const profileFolderName = (p: { id: string; name: string }): string => `${p.name.replace(/[\\/]/g, "-")} (${p.id.slice(0, 8)})`;

export async function resolveFolders(drive: DriveClient, cached: Partial<DriveFolders> | undefined, profile: { id: string; name: string }): Promise<DriveFolders> {
  const alive = async (id: string | undefined, parent?: string): Promise<boolean> => {
    if (!id) return false;
    const f = await drive.getFile(id);
    return !!f && !f.trashed && (!parent || (f.parents ?? []).includes(parent));
  };
  const root = (await alive(cached?.root)) ? cached!.root! : (await drive.ensureFolder(ROOT_FOLDER_NAME, "root")).id;
  const backups = (await alive(cached?.backups, root)) ? cached!.backups! : (await drive.ensureFolder(BACKUPS_FOLDER_NAME, root)).id;

  const wanted = profileFolderName(profile);
  let profileId: string;
  if (await alive(cached?.profile, backups)) {
    profileId = cached!.profile!;
  } else {
    const found = (await drive.findFolderByProperty(backups, "soupProfileId", profile.id)) ?? (await drive.findByName(wanted, backups, "application/vnd.google-apps.folder"));
    profileId = found ? found.id : (await drive.createFolder(wanted, backups, { soupProfileId: profile.id })).id;
  }
  const library = (await alive(cached?.library, profileId)) ? cached!.library! : (await drive.ensureFolder(LIBRARY_FOLDER_NAME, profileId)).id;
  return { root, backups, profile: profileId, library };
}
