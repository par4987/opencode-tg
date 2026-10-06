/**
 * MessageCards: picker state bound to the message that carries its keyboard.
 *
 * What must hold (the "queue mezcla chats" incident): a callback addresses
 * ONLY the card it lives in — a second picker opened elsewhere never
 * rebinds an older keyboard; a settled card cannot be replayed by a second
 * tap; and the history is capped.
 */
import { MessageCards } from "../src/message-cards.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

interface Card {
  session: string;
  items: string[];
}

function main(): void {
  const cards = new MessageCards<Card>(3);

  // 1. Binding: each message reads its own state.
  cards.set(101, { session: "ses_a", items: ["a1", "a2"] });
  cards.set(202, { session: "ses_b", items: ["b1"] });
  check("el mensaje 101 lee su propio card", cards.get(101)?.session === "ses_a");
  check("el mensaje 202 lee el suyo", cards.get(202)?.session === "ses_b");
  check("un mensaje sin card es undefined", cards.get(999) === undefined);
  check("messageId undefined es undefined", cards.get(undefined) === undefined);

  // 2. THE INCIDENT: a card mutated by its own buttons keeps its identity;
  //    the other card is untouched — no rebinding across threads.
  const a = cards.get(101);
  a?.items.splice(0, 1);
  check("la mutacion del card 101 no toca al 202", (cards.get(202)?.items.length ?? 0) === 1);
  check("y el card 101 ve su mutacion", cards.get(101)?.items.length === 1);

  // 3. drop: a settled action is not replayed by a second tap.
  cards.drop(202);
  check("tras drop, el card expiro", cards.get(202) === undefined);
  check("drop de un id inexistente no rompe", (() => {
    cards.drop(404);
    return true;
  })());

  // 4. Cap: the oldest binding is evicted, the newest stay.
  cards.set(301, { session: "ses_c", items: [] });
  cards.set(401, { session: "ses_d", items: [] });
  cards.set(501, { session: "ses_e", items: [] }); // evicts 101 (cap 3)
  check("el cap desaloja al mas viejo", cards.get(101) === undefined);
  check("los recientes sobreviven", cards.get(301)?.session === "ses_c" && cards.get(501)?.session === "ses_e");

  console.log(failures === 0 ? "\nCARDS OK" : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
