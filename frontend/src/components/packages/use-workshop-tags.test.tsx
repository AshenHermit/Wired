import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listWorkshopTags } from "@/api/services/scripting-packages";
import {
  resetWorkshopTagsCache,
  useWorkshopTags,
} from "./use-workshop-tags";

vi.mock("@/api/services/scripting-packages", () => ({
  listWorkshopTags: vi.fn(),
}));

const listing = { items: [{ tag: "hero", count: 2 }], total: 1 };

beforeEach(() => {
  vi.useRealTimers();
  resetWorkshopTagsCache();
  vi.mocked(listWorkshopTags).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useWorkshopTags", () => {
  it("requests every tag once and reuses the cache within the TTL", async () => {
    vi.mocked(listWorkshopTags).mockResolvedValue(listing);

    const first = renderHook(() => useWorkshopTags());
    await waitFor(() => expect(first.result.current.tags).toEqual(listing.items));
    expect(listWorkshopTags).toHaveBeenCalledWith({ limit: 200 });
    first.unmount();

    const second = renderHook(() => useWorkshopTags());
    await waitFor(() =>
      expect(second.result.current.tags).toEqual(listing.items),
    );
    expect(listWorkshopTags).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent mounts into one request", async () => {
    let resolve!: (value: typeof listing) => void;
    vi.mocked(listWorkshopTags).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );

    const first = renderHook(() => useWorkshopTags());
    const second = renderHook(() => useWorkshopTags());
    expect(listWorkshopTags).toHaveBeenCalledTimes(1);

    resolve(listing);
    await waitFor(() => expect(first.result.current.tags).toEqual(listing.items));
    await waitFor(() =>
      expect(second.result.current.tags).toEqual(listing.items),
    );
  });

  it("refetches after the cache expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T00:00:00.000Z"));
    vi.mocked(listWorkshopTags).mockResolvedValue(listing);

    const first = renderHook(() => useWorkshopTags());
    await waitFor(() => expect(first.result.current.tags).toEqual(listing.items));
    first.unmount();

    vi.setSystemTime(new Date("2026-11-03T00:01:01.000Z"));

    const second = renderHook(() => useWorkshopTags());
    await waitFor(() => expect(listWorkshopTags).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(second.result.current.tags).toEqual(listing.items),
    );
  });

  it("caches a failed request as an empty list", async () => {
    vi.mocked(listWorkshopTags).mockRejectedValue(new Error("offline"));

    const first = renderHook(() => useWorkshopTags());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.tags).toEqual([]);
    first.unmount();

    renderHook(() => useWorkshopTags());
    await waitFor(() => expect(listWorkshopTags).toHaveBeenCalledTimes(1));
  });
});
