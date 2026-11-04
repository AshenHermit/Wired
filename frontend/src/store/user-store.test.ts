import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@wired-io/shared";

const { getProfile } = vi.hoisted(() => ({ getProfile: vi.fn() }));

vi.mock("@/api/services/profile", () => ({ getProfile }));

import { defaultUserObject, useUserStore } from "./user-store";

const profile: User = {
  id: 7,
  email: "ann@wired.io",
  name: "Ann",
  service: "google",
  picture: "data:image/png;base64,aa",
};

describe("useUserStore", () => {
  beforeEach(() => {
    getProfile.mockReset();
    useUserStore.setState({ ...defaultUserObject, loaded: false });
  });

  it("starts signed out and unloaded", () => {
    const state = useUserStore.getState();

    expect(state.authorized).toBe(false);
    expect(state.id).toBe(-1);
    expect(state.loaded).toBe(false);
  });

  it("stores a loaded profile as authorized", async () => {
    getProfile.mockResolvedValue(profile);

    useUserStore.getState().loadUser();
    await vi.waitFor(() => expect(useUserStore.getState().loaded).toBe(true));

    const state = useUserStore.getState();
    expect(state.authorized).toBe(true);
    expect(state.id).toBe(7);
    expect(state.email).toBe("ann@wired.io");
  });

  it("settles on the signed-out object when the caller has no session", async () => {
    getProfile.mockResolvedValue(null);

    useUserStore.getState().loadUser();
    await vi.waitFor(() => expect(useUserStore.getState().loaded).toBe(true));

    const state = useUserStore.getState();
    expect(state.authorized).toBe(false);
    expect(state.id).toBe(-1);
  });

  it("finishes loading when the profile request fails", async () => {
    getProfile.mockRejectedValue(new Error("offline"));

    useUserStore.getState().loadUser();
    await vi.waitFor(() => expect(useUserStore.getState().loaded).toBe(true));

    const state = useUserStore.getState();
    expect(state.authorized).toBe(false);
    expect(state.id).toBe(-1);
  });

  it("replaces the user through setUser", () => {
    useUserStore.getState().setUser({ ...profile, authorized: true });

    expect(useUserStore.getState().name).toBe("Ann");
    expect(useUserStore.getState().authorized).toBe(true);
  });
});
