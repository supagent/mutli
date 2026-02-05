# Client Streaming Protocol

How clients receive real-time agent events via WebSocket (Gateway mode) or IPC (Desktop mode), and what data structures to use for rendering.

## Transport Overview

```
Gateway mode (Web App):
  Client  ←──WebSocket──→  Gateway  ←──→  Hub  ←──→  Agent

Desktop mode (Electron):
  Renderer  ←──IPC──→  Main Process (Hub + Agent)
```

Both transports deliver the same logical events. The client receives a `StreamPayload` envelope containing an event, and routes it to the store for rendering.

## StreamPayload Envelope

Every real-time event arrives wrapped in a `StreamPayload`:

```ts
interface StreamPayload {
  streamId: string;   // groups events belonging to the same assistant turn
  agentId: string;    // which agent produced this event
  event: AgentEvent | CompactionEvent;
}
```

In Gateway mode, these arrive as Socket.io messages with `action = "stream"`. In Desktop IPC mode, they arrive as `localChat:event` messages with the same structure.

## Event Types

### 1. Message Lifecycle Events (AgentEvent)

These events represent an LLM response being generated in real time.

#### `message_start`

A new assistant message has begun streaming.

```json
{
  "streamId": "019abc12-...",
  "agentId": "019def34-...",
  "event": {
    "type": "message_start",
    "message": {
      "role": "assistant",
      "content": []
    }
  }
}
```

**Client action:** Create a new empty assistant message bubble. Use `streamId` as the message ID for subsequent updates.

#### `message_update`

Partial content has arrived for the current message.

```json
{
  "streamId": "019abc12-...",
  "agentId": "019def34-...",
  "event": {
    "type": "message_update",
    "message": {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "Here is the partial response so far..." },
        { "type": "thinking", "thinking": "Let me consider..." }
      ]
    }
  }
}
```

**Client action:** Replace the message's `content` array with the new snapshot. Each update contains the full accumulated content, not a delta.

#### `message_end`

The assistant message is complete.

```json
{
  "streamId": "019abc12-...",
  "agentId": "019def34-...",
  "event": {
    "type": "message_end",
    "message": {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "Final complete response." }
      ],
      "stopReason": "end_turn"
    }
  }
}
```

**Client action:** Finalize the message. Mark streaming as complete. Extract `stopReason` if needed.

### 2. Tool Execution Events (AgentEvent)

These events track tool calls made by the assistant during a turn.

#### `tool_execution_start`

The agent has begun executing a tool.

```json
{
  "streamId": "019abc12-...",
  "agentId": "019def34-...",
  "event": {
    "type": "tool_execution_start",
    "toolCallId": "toolu_01ABC...",
    "toolName": "Bash",
    "args": { "command": "ls -la" }
  }
}
```

**Client action:** Create a tool result message with `toolStatus: "running"`. Display a spinner or loading indicator.

#### `tool_execution_end`

The tool has finished executing.

```json
{
  "streamId": "019abc12-...",
  "agentId": "019def34-...",
  "event": {
    "type": "tool_execution_end",
    "toolCallId": "toolu_01ABC...",
    "result": "file1.txt\nfile2.txt\n",
    "isError": false
  }
}
```

**Client action:** Update the matching tool result message. Set `toolStatus` to `"success"` or `"error"` based on `isError`. Render `result` as the tool output.

### 3. Compaction Events (CompactionEvent)

These events notify the client when context window compaction occurs. They use a synthetic `streamId` of `compaction:{agentId}` and do not belong to any message stream.

#### `compaction_start`

Context compaction has begun. The agent is removing old messages to free up context window space.

```json
{
  "streamId": "compaction:019def34-...",
  "agentId": "019def34-...",
  "event": {
    "type": "compaction_start"
  }
}
```

**Client action:** Show a compaction indicator (e.g., "Compacting context...").

#### `compaction_end`

Compaction is complete. Includes statistics about what was removed.

```json
{
  "streamId": "compaction:019def34-...",
  "agentId": "019def34-...",
  "event": {
    "type": "compaction_end",
    "removed": 24,
    "kept": 8,
    "tokensRemoved": 45000,
    "tokensKept": 12000,
    "reason": "tokens"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `removed` | `number` | Number of messages removed |
| `kept` | `number` | Number of messages retained |
| `tokensRemoved` | `number?` | Estimated tokens freed (absent in count mode) |
| `tokensKept` | `number?` | Estimated tokens remaining (absent in count mode) |
| `reason` | `string` | What triggered compaction: `"tokens"`, `"count"`, or `"summary"` |

**Client action:** Hide the compaction indicator. Optionally display a toast or inline notice with the stats.

## Content Block Types

Message content is an array of `ContentBlock`, which is a union of:

```ts
// Plain text
interface TextContent {
  type: "text";
  text: string;
}

// LLM reasoning (extended thinking)
interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

// Tool invocation (appears in assistant messages)
interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// Image content (appears in user messages)
interface ImageContent {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
```

## Client-Side Store Structure

The recommended Zustand store shape for rendering:

```ts
interface Message {
  id: string;
  role: "user" | "assistant" | "toolResult";
  content: ContentBlock[];
  agentId: string;
  stopReason?: string;
  // Tool result fields (role === "toolResult" only)
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolStatus?: "running" | "success" | "error" | "interrupted";
  isError?: boolean;
}

interface CompactionStats {
  removed: number;
  kept: number;
  tokensRemoved?: number;
  tokensKept?: number;
  reason: string;
}

interface MessagesState {
  messages: Message[];
  streamingIds: Set<string>;          // IDs of messages currently streaming
  compacting: boolean;                // true while compaction is in progress
  lastCompaction: CompactionStats | null;  // stats from most recent compaction
}
```

## Event Routing Pseudocode

```ts
function handleStreamEvent(payload: StreamPayload) {
  const { streamId, agentId, event } = payload;

  switch (event.type) {
    case "message_start":
      store.startStream(streamId, agentId);
      break;
    case "message_update":
      store.appendStream(streamId, event.message.content);
      break;
    case "message_end":
      store.endStream(streamId, event.message.content, event.message.stopReason);
      break;
    case "tool_execution_start":
      store.startToolExecution(agentId, event.toolCallId, event.toolName, event.args);
      break;
    case "tool_execution_end":
      store.endToolExecution(event.toolCallId, event.result, event.isError);
      break;
    case "compaction_start":
      store.startCompaction();
      break;
    case "compaction_end":
      store.endCompaction({
        removed: event.removed,
        kept: event.kept,
        tokensRemoved: event.tokensRemoved,
        tokensKept: event.tokensKept,
        reason: event.reason,
      });
      break;
  }
}
```

## Message History via RPC

Clients can also fetch historical messages using the `getAgentMessages` RPC method. See [rpc.md](./rpc.md) for details.

The response returns `AgentMessage[]` which must be normalized into the `Message` format above. Key differences from streaming:

- Historical messages don't have `toolStatus` — infer it from `isError` (`"error"` or `"success"`).
- Historical messages may have `content` as a plain `string` instead of `ContentBlock[]` — normalize by wrapping in `[{ type: "text", text: content }]`.
- Tool arguments are not stored on `toolResult` messages — build a lookup map from assistant `ToolCall` blocks by `toolCallId` to reconstruct `toolArgs`.

## SDK Imports

All types are available from `@multica/sdk`:

```ts
import {
  StreamAction,
  type StreamPayload,
  type AgentEvent,
  type CompactionEvent,
  type CompactionStartEvent,
  type CompactionEndEvent,
  type ContentBlock,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type ImageContent,
} from "@multica/sdk";
```

Store types are available from `@multica/store`:

```ts
import {
  useMessagesStore,
  type Message,
  type CompactionStats,
  type ToolStatus,
} from "@multica/store";
```
