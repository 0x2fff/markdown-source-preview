import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { PreviewProvider } from './previewProvider.js';

export function activate(ctx: vscode.ExtensionContext): void {
  const provider = new PreviewProvider(ctx);

  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      PreviewProvider.VIEW_TYPE,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
          enableFindWidget: false,
        },
        supportsMultipleEditorsPerDocument: false,
      },
    ),
  );

  // Open the active editor's .md file via command
  ctx.subscriptions.push(
    vscode.commands.registerCommand('markdownSourcePreview.openPreview', async () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (!uri || !uri.fsPath.endsWith('.md')) {
        vscode.window.showInformationMessage('Open a .md file first.');
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        PreviewProvider.VIEW_TYPE,
        vscode.ViewColumn.Beside,
      );
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('markdownSourcePreview.toggleEditMode', () => provider.toggleEditMode()),
    vscode.commands.registerCommand('markdownSourcePreview.enterEditMode', () => provider.enterEditMode()),
    vscode.commands.registerCommand('markdownSourcePreview.exitEditMode', () => provider.exitEditMode()),
    vscode.commands.registerCommand('markdownSourcePreview.openMermaidGraphicalEditor', () => provider.openMermaidGraphicalEditor()),
  );

  if (__MARKDOWN_SOURCE_PREVIEW_LAB__ && process.env.MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS === '1') {
    ctx.subscriptions.push(
      vscode.commands.registerCommand(
        'markdownSourcePreview.diagnosticsPrepareDispose',
        () => provider.prepareDisposeForDiagnostics(),
      ),
      vscode.commands.registerCommand(
        'markdownSourcePreview.diagnosticsOpenReadonlyUri',
        async () => {
          console.log('[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_READONLY_URI_CMD] invoked');
          const document = await vscode.workspace.openTextDocument({
            content: '# Readonly Diagnostics\n\nThis document uses the untitled scheme.\n',
            language: 'markdown',
          });
          await vscode.commands.executeCommand(
            'vscode.openWith',
            document.uri,
            PreviewProvider.VIEW_TYPE,
            vscode.ViewColumn.Active,
          );
        },
      ),
    );

    // Diagnostics command channel: JSON lines appended to the file at
    // MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_CHANNEL are executed as commands.
    // Used by automated tests because diagnostic commands are not
    // contributed to the manifest and never appear in the palette.
    const channelPath = process.env.MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_CHANNEL;
    if (channelPath) {
      let offset = 0;
      const pump = (): void => {
        let text: string;
        try {
          text = fs.readFileSync(channelPath, 'utf8');
        } catch {
          return;
        }
        if (text.length < offset) offset = 0;
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline < offset) return;
        const chunk = text.slice(offset, lastNewline);
        offset = lastNewline + 1;
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as { command?: unknown; args?: unknown };
            if (typeof msg.command !== 'string') continue;
            const args = Array.isArray(msg.args) ? msg.args : [];
            void vscode.commands.executeCommand(msg.command, ...args);
          } catch (error) {
            console.warn(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS] bad channel line: ${String(error)}`);
          }
        }
      };
      fs.watchFile(channelPath, { interval: 100 }, pump);
      ctx.subscriptions.push({ dispose: () => fs.unwatchFile(channelPath, pump) });
    }
  }
}

export function deactivate(): void {
  // noop — subscriptions are disposed automatically
}
