import { describe, expect, it } from "vitest";
import { isGameMessage } from "./game-bridge";

describe("isGameMessage", () => {
  it("accepts every well-formed message the host handles", () => {
    expect(
      isGameMessage({ source: "wired-game", type: "wired:game-ready", payload: {} }),
    ).toBe(true);
    expect(
      isGameMessage({
        source: "wired-game",
        type: "wired:game-status",
        payload: { stage: "authenticated", detail: "" },
      }),
    ).toBe(true);
    expect(
      isGameMessage({
        source: "wired-game",
        type: "wired:game-configured",
        payload: { room: 8 },
      }),
    ).toBe(true);
    expect(
      isGameMessage({
        source: "wired-game",
        type: "wired:game-event",
        payload: { event: { type: "world_state" } },
      }),
    ).toBe(true);
  });

  it("rejects malformed payloads instead of throwing in the message listener", () => {
    expect(
      isGameMessage({ source: "wired-game", type: "wired:game-status" }),
    ).toBe(false);
    expect(
      isGameMessage({
        source: "wired-game",
        type: "wired:game-status",
        payload: { stage: "made-up" },
      }),
    ).toBe(false);
    expect(
      isGameMessage({
        source: "wired-game",
        type: "wired:game-configured",
        payload: { room: "8" },
      }),
    ).toBe(false);
    expect(
      isGameMessage({ source: "wired-game", type: "wired:unknown", payload: {} }),
    ).toBe(false);
    expect(
      isGameMessage({ source: "another-app", type: "wired:game-ready", payload: {} }),
    ).toBe(false);
  });
});
