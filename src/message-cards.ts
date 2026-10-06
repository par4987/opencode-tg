/**
 * Picker state bound to the message that carries its keyboard.
 *
 * The pre-fix bug class ("queue mezcla chats"): every picker — the queue,
 * models, agents, projects — lived in a single global, so opening one in a
 * second thread silently REBOUND the first thread's already-drawn keyboard
 * to the second session. A button in an old card then acted on another
 * session's list: the queue card in thread A steered thread B's pending
 * message, /models in A switched B's model, and so on.
 *
 * The fix is structural: state rides on the message id of the card it was
 * rendered into, and a callback only ever addresses the card it lives in.
 * A cap keeps a tapper's history from growing without bound.
 */
export class MessageCards<T> {
  private readonly map = new Map<number, T>();

  constructor(private readonly cap = 30) {}

  /** Bind state to a message; the oldest binding is evicted at the cap. */
  set(messageId: number, state: T): void {
    this.map.set(messageId, state);
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** The state of THIS message's card, if the card is still around. */
  get(messageId: number | undefined): T | undefined {
    return messageId === undefined ? undefined : this.map.get(messageId);
  }

  /** Drop one card — a settled action must not be replayed by a second tap. */
  drop(messageId: number | undefined): void {
    if (messageId !== undefined) this.map.delete(messageId);
  }
}
