import { describe, expect, it, vi } from "vitest";
import { createVerifyHandler } from "./verify.js";
import { RpcError } from "../dispatcher.js";
import type { DeviceStore } from "../../device-store.js";

function createDeviceStoreStub() {
  return {
    isAllowed: vi.fn(),
    consumeToken: vi.fn(),
    allowDevice: vi.fn(),
  } as unknown as DeviceStore;
}

describe("createVerifyHandler", () => {
  it("returns existing authorized conversation scope without consuming token", async () => {
    const deviceStore = createDeviceStoreStub();
    const storeApi = deviceStore as unknown as {
      isAllowed: ReturnType<typeof vi.fn>;
      consumeToken: ReturnType<typeof vi.fn>;
      allowDevice: ReturnType<typeof vi.fn>;
    };
    storeApi.isAllowed.mockReturnValue({
      agentId: "agent-1",
      conversationIds: ["conv-1"],
    });

    const onConfirmDevice = vi.fn(async () => true);
    const handler = createVerifyHandler({
      hubId: "hub-1",
      deviceStore,
      resolveMainConversationId: () => "conv-1",
      onConfirmDevice,
    });

    const result = await handler({}, "dev-1");
    expect(result).toEqual({
      hubId: "hub-1",
      agentId: "agent-1",
      conversationId: "conv-1",
      sessionId: "conv-1",
      mainConversationId: "conv-1",
      isNewDevice: false,
    });
    expect(storeApi.consumeToken).not.toHaveBeenCalled();
    expect(onConfirmDevice).not.toHaveBeenCalled();
  });

  it("consumes token, confirms device, and stores conversation scope", async () => {
    const deviceStore = createDeviceStoreStub();
    const storeApi = deviceStore as unknown as {
      isAllowed: ReturnType<typeof vi.fn>;
      consumeToken: ReturnType<typeof vi.fn>;
      allowDevice: ReturnType<typeof vi.fn>;
    };
    storeApi.isAllowed.mockReturnValue(null);
    storeApi.consumeToken.mockReturnValue({
      agentId: "agent-2",
      conversationId: "conv-2",
    });

    const onConfirmDevice = vi.fn(async () => true);
    const handler = createVerifyHandler({
      hubId: "hub-2",
      deviceStore,
      resolveMainConversationId: () => "conv-2",
      onConfirmDevice,
    });

    const result = await handler({ token: "token-2" }, "dev-2");
    expect(result).toEqual({
      hubId: "hub-2",
      agentId: "agent-2",
      conversationId: "conv-2",
      sessionId: "conv-2",
      mainConversationId: "conv-2",
      isNewDevice: true,
    });
    expect(onConfirmDevice).toHaveBeenCalledWith("dev-2", "agent-2", "conv-2", undefined);
    expect(storeApi.allowDevice).toHaveBeenCalledWith("dev-2", "agent-2", "conv-2", undefined);
  });

  it("throws REJECTED when user denies device confirmation", async () => {
    const deviceStore = createDeviceStoreStub();
    const storeApi = deviceStore as unknown as {
      isAllowed: ReturnType<typeof vi.fn>;
      consumeToken: ReturnType<typeof vi.fn>;
      allowDevice: ReturnType<typeof vi.fn>;
    };
    storeApi.isAllowed.mockReturnValue(null);
    storeApi.consumeToken.mockReturnValue({
      agentId: "agent-3",
      conversationId: "conv-3",
    });

    const handler = createVerifyHandler({
      hubId: "hub-3",
      deviceStore,
      onConfirmDevice: async () => false,
    });

    await expect(handler({ token: "token-3" }, "dev-3")).rejects.toMatchObject({
      code: "REJECTED",
    } satisfies Partial<RpcError>);
    expect(storeApi.allowDevice).not.toHaveBeenCalled();
  });
});
