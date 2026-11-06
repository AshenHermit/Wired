import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl as render } from "@/test/render-with-intl";
import { withApiPrefix } from "@/utils/variables";
import { ImageUploadField } from "./ImageUploadField";

const { uploadMedia } = vi.hoisted(() => ({
  uploadMedia: vi.fn(),
}));

vi.mock("@/api/services/media", () => ({ uploadMedia }));

const URL = `/media/${"d".repeat(64)}.png`;

describe("ImageUploadField", () => {
  beforeEach(() => {
    uploadMedia.mockReset();
  });

  it("renders the current image through the API prefix", () => {
    const { container } = render(
      <ImageUploadField value={URL} onChange={() => undefined} />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", withApiPrefix(URL));
  });

  it("does not render a bound preview image when value is null", () => {
    const { container } = render(
      <ImageUploadField value={null} onChange={() => undefined} />,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("uploads a chosen file and calls onChange with the URL", async () => {
    const onChange = vi.fn();
    uploadMedia.mockResolvedValueOnce({ url: URL });
    render(<ImageUploadField value={null} onChange={onChange} />);

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File([new Uint8Array([0x89, 0x50])], "shot.png", {
      type: "image/png",
    });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(uploadMedia).toHaveBeenCalledWith(file);
      expect(onChange).toHaveBeenCalledWith(URL);
    });
  });

  it("uploads a pasted image and calls onChange", async () => {
    const onChange = vi.fn();
    uploadMedia.mockResolvedValueOnce({ url: URL });
    const { container } = render(
      <ImageUploadField value={null} onChange={onChange} />,
    );

    const root = container.firstElementChild as HTMLElement;
    fireEvent.focus(root);
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "paste.jpg", {
      type: "image/jpeg",
    });
    fireEvent.paste(root, {
      clipboardData: {
        files: [file],
        items: [{ kind: "file", type: "image/jpeg", getAsFile: () => file }],
        types: ["Files"],
      },
    });

    await waitFor(() => {
      expect(uploadMedia).toHaveBeenCalledWith(file);
      expect(onChange).toHaveBeenCalledWith(URL);
    });
  });

  it("clears the value when remove is clicked", () => {
    const onChange = vi.fn();
    render(<ImageUploadField value={URL} onChange={onChange} />);
    fireEvent.click(
      screen.getByRole("button", { name: /remove|удалить/i }),
    );
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
