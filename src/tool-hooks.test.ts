import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventType } from "@ag-ui/core";

vi.mock("openclaw/plugin-sdk", () => ({
  emptyPluginConfigSchema: () => ({}),
}));

import {
  setWriter,
  clearWriter,
  markClientToolNames,
  clearClientToolNames,
  clearToolFiredInRun,
  wasToolFiredInRun,
} from "./tool-store.js";
import {
  handleBeforeToolCall,
  handleToolResultPersist,
} from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_KEY = "hook-test-session";

function createMockWriter() {
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  const writer = (event: { type: string } & Record<string, unknown>) => {
    events.push(event);
  };
  return { events, writer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tool event hooks", () => {
  let mock: ReturnType<typeof createMockWriter>;

  beforeEach(() => {
    mock = createMockWriter();
    setWriter(SESSION_KEY, mock.writer, "msg-001");
  });

  afterEach(() => {
    clearWriter(SESSION_KEY);
    clearClientToolNames(SESSION_KEY);
    clearToolFiredInRun(SESSION_KEY);
  });

  // -------------------------------------------------------------------------
  // Client tools
  // -------------------------------------------------------------------------

  describe("client tools", () => {
    beforeEach(() => {
      markClientToolNames(SESSION_KEY, ["get_weather"]);
    });

    it("emits TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END", () => {
      handleBeforeToolCall(
        { toolName: "get_weather", params: { city: "Tokyo" } },
        { sessionKey: SESSION_KEY },
      );

      expect(mock.events).toHaveLength(3);
      expect(mock.events[0].type).toBe(EventType.TOOL_CALL_START);
      expect(mock.events[0].toolCallName).toBe("get_weather");
      expect(mock.events[0].toolCallId).toMatch(/^tool-/);

      expect(mock.events[1].type).toBe(EventType.TOOL_CALL_ARGS);
      expect(mock.events[1].delta).toBe(JSON.stringify({ city: "Tokyo" }));
      expect(mock.events[1].toolCallId).toBe(mock.events[0].toolCallId);

      expect(mock.events[2].type).toBe(EventType.TOOL_CALL_END);
      expect(mock.events[2].toolCallId).toBe(mock.events[0].toolCallId);
    });

    it("skips TOOL_CALL_ARGS when params are empty", () => {
      handleBeforeToolCall(
        { toolName: "get_weather", params: {} },
        { sessionKey: SESSION_KEY },
      );

      expect(mock.events).toHaveLength(2);
      expect(mock.events[0].type).toBe(EventType.TOOL_CALL_START);
      expect(mock.events[1].type).toBe(EventType.TOOL_CALL_END);
    });

    it("skips TOOL_CALL_ARGS when params are undefined", () => {
      handleBeforeToolCall(
        { toolName: "get_weather" },
        { sessionKey: SESSION_KEY },
      );

      expect(mock.events).toHaveLength(2);
      expect(mock.events[0].type).toBe(EventType.TOOL_CALL_START);
      expect(mock.events[1].type).toBe(EventType.TOOL_CALL_END);
    });

    it("sets toolFiredInRun flag", () => {
      expect(wasToolFiredInRun(SESSION_KEY)).toBe(false);

      handleBeforeToolCall(
        { toolName: "get_weather", params: { city: "Tokyo" } },
        { sessionKey: SESSION_KEY },
      );

      expect(wasToolFiredInRun(SESSION_KEY)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Server tools
  // -------------------------------------------------------------------------

  describe("server tools", () => {
    it("emits TOOL_CALL_START + TOOL_CALL_ARGS on before_tool_call, then TOOL_CALL_RESULT + TOOL_CALL_END on persist", () => {
      handleBeforeToolCall(
        { toolName: "search_db", params: { query: "test" } },
        { sessionKey: SESSION_KEY },
      );

      // After before_tool_call: START + ARGS only (no END yet)
      expect(mock.events).toHaveLength(2);
      expect(mock.events[0].type).toBe(EventType.TOOL_CALL_START);
      expect(mock.events[0].toolCallName).toBe("search_db");
      expect(mock.events[1].type).toBe(EventType.TOOL_CALL_ARGS);
      expect(mock.events[1].delta).toBe(JSON.stringify({ query: "test" }));

      const toolCallId = mock.events[0].toolCallId;

      // After tool_result_persist: RESULT + END
      handleToolResultPersist({}, { sessionKey: SESSION_KEY });

      expect(mock.events).toHaveLength(4);
      expect(mock.events[2].type).toBe(EventType.TOOL_CALL_RESULT);
      expect(mock.events[2].toolCallId).toBe(toolCallId);
      expect(mock.events[2].messageId).toBe("msg-001");
      expect(mock.events[3].type).toBe(EventType.TOOL_CALL_END);
      expect(mock.events[3].toolCallId).toBe(toolCallId);
    });

    it("does not emit RESULT/END when no pending toolCallId exists", () => {
      // Call persist without a prior before_tool_call
      handleToolResultPersist({}, { sessionKey: SESSION_KEY });

      expect(mock.events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("does nothing when sessionKey is undefined (before_tool_call)", () => {
      handleBeforeToolCall(
        { toolName: "get_weather", params: { city: "Tokyo" } },
        { sessionKey: undefined },
      );

      expect(mock.events).toHaveLength(0);
    });

    it("does nothing when sessionKey is undefined (tool_result_persist)", () => {
      handleToolResultPersist({}, { sessionKey: undefined });

      expect(mock.events).toHaveLength(0);
    });

    it("does nothing when no writer is registered", () => {
      clearWriter(SESSION_KEY);

      handleBeforeToolCall(
        { toolName: "get_weather", params: { city: "Tokyo" } },
        { sessionKey: SESSION_KEY },
      );

      expect(mock.events).toHaveLength(0);
    });

    it("generates unique toolCallIds across calls", () => {
      markClientToolNames(SESSION_KEY, ["tool_a", "tool_b"]);

      handleBeforeToolCall(
        { toolName: "tool_a", params: { x: 1 } },
        { sessionKey: SESSION_KEY },
      );
      handleBeforeToolCall(
        { toolName: "tool_b", params: { y: 2 } },
        { sessionKey: SESSION_KEY },
      );

      const ids = mock.events
        .filter((e) => e.type === EventType.TOOL_CALL_START)
        .map((e) => e.toolCallId);
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
    });
  });
});
