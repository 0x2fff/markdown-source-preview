/**
 * Helpers for the external Mermaid Graphical Editor extension
 * (corschenzi.mermaid-graphical-editor).
 *
 * The external extension's command IDs are not a stable API, so they
 * are discovered from its manifest instead of hardcoded. Auto-launch
 * happens only when exactly one contributed command exists; otherwise
 * the editor CodeLens is left to the user.
 */

import * as vscode from 'vscode';
import type { RenderBlock } from '../core/renderModel.js';

const MERMAID_GRAPHICAL_EXTENSION_ID = 'corschenzi.mermaid-graphical-editor';

/** Returns command IDs contributed by the installed extension's manifest. */
export function getMermaidGraphicalCommands(): string[] {
  const extension = vscode.extensions.getExtension(MERMAID_GRAPHICAL_EXTENSION_ID);
  const commands = extension?.packageJSON?.contributes?.commands;
  if (!Array.isArray(commands)) return [];
  return commands
    .map((entry: unknown) => (entry as { command?: unknown })?.command)
    .filter((value): value is string => typeof value === 'string');
}

/** Reveals the block's source range so the external editor's CodeLens appears. */
export async function revealMermaidSource(
  document: vscode.TextDocument,
  block: RenderBlock,
): Promise<vscode.TextEditor> {
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: false,
    preview: false,
  });

  const start = new vscode.Position(block.sourceStart, 0);
  const endLine = Math.max(block.sourceStart, block.sourceEnd - 1);
  const end = new vscode.Position(endLine, document.lineAt(endLine).text.length);

  editor.selection = new vscode.Selection(start, start);
  editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
  return editor;
}

/** Returns the external command only when exactly one candidate exists. */
export async function resolveMermaidGraphicalCommand(): Promise<string | undefined> {
  const contributed = getMermaidGraphicalCommands();
  if (!contributed.length) return undefined;
  const available = await vscode.commands.getCommands(true);
  const candidates = contributed.filter(command => available.includes(command));
  return candidates.length === 1 ? candidates[0] : undefined;
}
