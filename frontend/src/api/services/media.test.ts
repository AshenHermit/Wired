import { describe, expect, it, vi } from "vitest";

const { apiClient } = vi.hoisted(() => ({
  apiClient: {
    postFile: vi.fn(),
  },
}));

vi.mock("../api-client/api-client", () => ({ apiClient }));

import { uploadMedia } from "./media";

describe("uploadMedia", () => {
  it("posts the file to media and returns the URL", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", {
      type: "image/png",
    });
    apiClient.postFile.mockResolvedValueOnce({
      url: `/media/${"a".repeat(64)}.png`,
    });

    await expect(uploadMedia(file)).resolves.toEqual({
      url: `/media/${"a".repeat(64)}.png`,
    });
    expect(apiClient.postFile).toHaveBeenCalledWith("media", file);
  });
});
