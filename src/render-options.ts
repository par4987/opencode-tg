/** Shared render settings, kept separate so config.ts does not import stream.ts. */
export interface RenderOptions {
  /** Throttle between edits of the same message. Telegram allows ~1/s. */
  editIntervalMs: number;
  /** Show diff blocks for edit/write (they are the most useful part). */
  showDiffs: boolean;
  diffMaxLines: number;
  /** Render the model's reasoning (collapsed, capped). */
  showReasoning: boolean;
  /** Cap on a reasoning block. */
  reasoningChars: number;
}
