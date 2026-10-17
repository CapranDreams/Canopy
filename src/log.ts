import * as vscode from 'vscode';

/** Thin wrapper over a LogOutputChannel so modules can log without holding vscode state. */
export class Log implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('CANOPY', { log: true });

  info(msg: string): void {
    this.channel.info(msg);
  }
  warn(msg: string): void {
    this.channel.warn(msg);
  }
  error(msg: string): void {
    this.channel.error(msg);
  }
  git(line: string): void {
    this.channel.info(line);
  }
  show(): void {
    this.channel.show(true);
  }
  dispose(): void {
    this.channel.dispose();
  }
}
