import { redactAiText } from "./safety-guard.js";

const SAFE_BOUNDARY = /[^A-Za-z0-9@._%+\- :=\/~]/gu;

export class AiStreamingRedactor {
  private pending = "";
  private count = 0;

  constructor(
    private readonly maxPendingChars = 8_000,
    private readonly maxPendingBytes = 32_768,
  ) {}

  push(text: string): string | null {
    this.pending += text;
    let end = 0;
    for (const match of this.pending.matchAll(SAFE_BOUNDARY)) {
      end = (match.index ?? 0) + match[0].length;
    }
    if (end > 0) return this.take(end);
    if (
      this.pending.length > this.maxPendingChars ||
      Buffer.byteLength(this.pending, "utf8") > this.maxPendingBytes
    ) {
      throw new Error("AI_OUTPUT_LIMIT");
    }
    return null;
  }

  flush(): string | null {
    return this.pending.length === 0 ? null : this.take(this.pending.length);
  }

  drainRedactionCount(): number {
    const count = this.count;
    this.count = 0;
    return count;
  }

  private take(end: number): string {
    const raw = this.pending.slice(0, end);
    this.pending = this.pending.slice(end);
    const redacted = redactAiText(raw);
    this.count += redacted.redactionCount;
    return redacted.text;
  }
}
