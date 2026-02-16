import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MessageContextQueue } from "./message-context-queue.js";

describe("MessageContextQueue", () => {
  it("keeps the first context active while newer messages stay pending", () => {
    const queue = new MessageContextQueue();
    const contextKey = "device-1:session-1";

    queue.enqueue(contextKey, { telegramChatId: 100, telegramMessageId: 1 });
    queue.enqueue(contextKey, { telegramChatId: 100, telegramMessageId: 2 });

    assert.deepEqual(queue.activate(contextKey), {
      telegramChatId: 100,
      telegramMessageId: 1,
    });
    assert.deepEqual(queue.peekForSend(contextKey), {
      telegramChatId: 100,
      telegramMessageId: 1,
    });

    assert.deepEqual(queue.release(contextKey), {
      telegramChatId: 100,
      telegramMessageId: 1,
    });
    assert.deepEqual(queue.peekForSend(contextKey), {
      telegramChatId: 100,
      telegramMessageId: 2,
    });
  });

  it("releases oldest pending context when a run errors before message_start", () => {
    const queue = new MessageContextQueue();
    const contextKey = "device-2:session-2";

    queue.enqueue(contextKey, { telegramChatId: 200, telegramMessageId: 11 });
    queue.enqueue(contextKey, { telegramChatId: 200, telegramMessageId: 12 });

    // No activate(): simulate agent_error before streaming starts
    assert.deepEqual(queue.release(contextKey), {
      telegramChatId: 200,
      telegramMessageId: 11,
    });
    assert.deepEqual(queue.peekForSend(contextKey), {
      telegramChatId: 200,
      telegramMessageId: 12,
    });
  });

  it("does not advance queue on repeated activate calls during one run", () => {
    const queue = new MessageContextQueue();
    const contextKey = "device-3:session-3";

    queue.enqueue(contextKey, { telegramChatId: 300, telegramMessageId: 21 });
    queue.enqueue(contextKey, { telegramChatId: 300, telegramMessageId: 22 });

    assert.equal(queue.activate(contextKey)?.telegramMessageId, 21);
    assert.equal(queue.activate(contextKey)?.telegramMessageId, 21);

    assert.equal(queue.release(contextKey)?.telegramMessageId, 21);
    assert.equal(queue.peekForSend(contextKey)?.telegramMessageId, 22);
  });

  it("isolates contexts by context key", () => {
    const queue = new MessageContextQueue();

    queue.enqueue("a:session-1", { telegramChatId: 1, telegramMessageId: 1 });
    queue.enqueue("a:session-2", { telegramChatId: 2, telegramMessageId: 2 });

    assert.equal(queue.activate("a:session-1")?.telegramMessageId, 1);
    assert.equal(queue.peekForSend("a:session-2")?.telegramMessageId, 2);
    assert.equal(queue.release("a:session-1")?.telegramMessageId, 1);
    assert.equal(queue.peekForSend("a:session-1"), undefined);
    assert.equal(queue.peekForSend("a:session-2")?.telegramMessageId, 2);
  });
});
