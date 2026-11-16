/**
 * Read-only detection for document URIs.
 *
 * Priority: non-file scheme → VS Code FilePermission → POSIX mode bits.
 * POSIX mode is always checked because workspace.fs.stat() may not
 * report permissions on macOS. Fails closed: undeterminable means
 * read-only.
 */

import * as vscode from 'vscode';
import { stat as fsStat } from 'node:fs/promises';

export type ReadonlyReason =
  | 'vscode-file-permission'
  | 'posix-mode'
  | 'unsupported-scheme'
  | 'stat-failed'
  | 'writable';

export interface ReadonlyResult {
  readonly: boolean;
  reason: ReadonlyReason;
  /** POSIX mode string (e.g. "444"); present only when stat succeeded. */
  mode?: string;
}

/** Pure decision function over VS Code permissions and POSIX mode. */
function readonlyFromPermissions(
  vscodePerm: number | undefined,
  posixMode: number,
): ReadonlyResult {
  if (
    vscodePerm !== undefined &&
    (vscodePerm & vscode.FilePermission.Readonly) !== 0
  ) {
    return {
      readonly: true,
      reason: 'vscode-file-permission',
      mode: (posixMode & 0o777).toString(8),
    };
  }

  const mode = (posixMode & 0o777).toString(8);
  if ((posixMode & 0o222) === 0) {
    // No write bit for owner, group, or other
    return { readonly: true, reason: 'posix-mode', mode };
  }

  return { readonly: false, reason: 'writable', mode };
}

/**
 * Returns the read-only state for a URI. Never throws: stat failures
 * return readonly with reason 'stat-failed'. Workspace trust is not
 * considered because editing is still possible in Restricted Mode.
 */
export async function detectReadonly(
  uri: vscode.Uri,
): Promise<ReadonlyResult> {
  if (uri.scheme !== 'file') {
    return { readonly: true, reason: 'unsupported-scheme' };
  }

  // 1. VS Code permission info (may be absent on macOS)
  let vscodePerm: number | undefined;
  try {
    vscodePerm = (await vscode.workspace.fs.stat(uri)).permissions;
  } catch {
    // Stat failure (deleted file, permission error, ...) → treat as read-only
    return { readonly: true, reason: 'stat-failed' };
  }

  // 2. Confirm via POSIX mode
  try {
    const posix = await fsStat(uri.fsPath);
    return readonlyFromPermissions(vscodePerm, posix.mode);
  } catch {
    return { readonly: true, reason: 'stat-failed' };
  }
}
