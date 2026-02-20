/**
 * PromptQueue — Simple async queue of user prompt strings.
 *
 * The orchestrator drains this queue and writes each prompt to the
 * claude CLI subprocess stdin as stream-json formatted messages.
 */

export class PromptQueue {
  private pending: string[] = [];
  private resolve: (() => void) | null = null;
  private closed = false;

  /** Push a text message into the queue. */
  enqueue(text: string): void {
    this.pending.push(text);
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  /** Stop the queue. */
  close(): void {
    this.closed = true;
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  /** Wait for and return the next message, or null if closed. */
  async next(): Promise<string | null> {
    while (!this.closed) {
      if (this.pending.length > 0) {
        return this.pending.shift()!;
      }
      await new Promise<void>((r) => { this.resolve = r; });
    }
    return this.pending.shift() ?? null;
  }
}
