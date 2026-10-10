/**
 * Image storage adapter: routes the outline editor's image reads and writes to **SiYuan assets**.
 *
 * Images must land in the SiYuan workspace, or the images in a note will not open on another device / client.
 *
 * This does **not** store binaries by id; it uploads the image directly as an assets file and
 * returns a relative path usable by `<img src>`. So this module keeps no local cache
 * —— the SiYuan workspace is the only storage.
 */
import type { SiYuanClient } from '../../siyuan/api';
import { t } from '../i18n';

let client: SiYuanClient | null = null;

/** Inject the SiYuan client on mount; pass null on unmount to reset, so containers cannot share one */
export function setOutlineImageClient(c: SiYuanClient | null): void {
  client = c;
}

/**
 * Uploads one image and returns a path usable by `<img src>` (of the form `assets/xxx.png`).
 *
 * Throws on failure instead of silently returning an empty string —— the caller needs to know the image was not stored,
 * otherwise it would write a path that can never load.
 */
export async function putImage(blob: Blob, filename = 'image.png'): Promise<string> {
  if (!client) throw new Error(t('errImageClientNotReady'));
  return client.uploadAsset(blob, filename);
}

/**
 * Resolves a storage path into a URL that can go straight into `<img src>`.
 *
 * In SiYuan, assets are reachable through the relative path `assets/xxx.png` (same origin),
 * so this mostly returns the path unchanged; but internal ids like `imgid://...`
 * are resolved to null instead, to avoid rendering a broken image.
 */
export async function getImageUrl(path: string): Promise<string | null> {
  if (!path) return null;
  // the `imgid://` form cannot be resolved inside the plugin
  if (path.startsWith('imgid://')) return null;
  // already a directly reachable address
  if (/^(https?:|data:|blob:|\/)/.test(path)) return path;
  // SiYuan assets relative path
  if (path.startsWith('assets/')) return path;
  return path;
}

/**
 * Deletes an image.
 *
 * The plugin version **deliberately does not delete anything for real**: once an image is in assets other blocks may already reference it,
 * and deleting it rashly would break images elsewhere. Removing the reference from the node is enough;
 * real cleanup is left to SiYuan's own asset management.
 */
export async function deleteImage(_path: string): Promise<void> {
  void _path;
}
