import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl as render } from "@/test/render-with-intl";
import { withApiPrefix } from "@/utils/variables";
import { ImageUploadField } from "./ImageUploadField";

const { uploadMedia } = vi.hoisted(() => ({
  uploadMedia: vi.fn(),
}));

const { toastError } = vi.hoisted(() => ({
  toastError: vi.fn(),
}));

vi.mock("@/api/services/media", () => ({ uploadMedia }));
vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn() },
}));

const URL = `/media/${"d".repeat(64)}.png`;

async function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button"), { button: 0 });
  await screen.findByRole("menuitem", { name: /вставить|paste/i });
}

describe("ImageUploadField", () => {
  beforeEach(() => {
    uploadMedia.mockReset();
    toastError.mockReset();
  });

  it("does not render the Media.label text", () => {
    render(<ImageUploadField value={null} onChange={() => undefined} />);
    expect(screen.queryByText(/Preview image|Превью/i)).toBeNull();
  });

  it("renders an empty-state icon when value is null", () => {
    const { container } = render(
      <ImageUploadField value={null} onChange={() => undefined} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button").querySelector("svg")).not.toBeNull();
  });

  it("renders the current image through the API prefix", () => {
    const { container } = render(
      <ImageUploadField value={URL} onChange={() => undefined} />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(withApiPrefix(URL));
  });

  it("uploads a chosen file via the Upload menu item", async () => {
    const onChange = vi.fn();
    uploadMedia.mockResolvedValueOnce({ url: URL });
    render(<ImageUploadField value={null} onChange={onChange} />);

    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /загрузить|upload/i }));

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

  it("uploads via the Paste menu item when the clipboard has an image", async () => {
    const onChange = vi.fn();
    uploadMedia.mockResolvedValueOnce({ url: URL });
    const blob = new Blob([new Uint8Array([0x89, 0x50])], {
      type: "image/png",
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ["image/png"],
            getType: async () => blob,
          },
        ]),
      },
    });

    render(<ImageUploadField value={null} onChange={onChange} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /вставить|paste/i }));

    await waitFor(() => {
      expect(uploadMedia).toHaveBeenCalled();
      expect(onChange).toHaveBeenCalledWith(URL);
    });
  });

  it("toasts and keeps value when clipboard paste yields no image", async () => {
    const onChange = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockRejectedValue(new Error("denied")),
      },
    });

    render(<ImageUploadField value={URL} onChange={onChange} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /вставить|paste/i }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uploads a focused-frame Ctrl/Cmd+V paste", async () => {
    const onChange = vi.fn();
    uploadMedia.mockResolvedValueOnce({ url: URL });
    render(<ImageUploadField value={null} onChange={onChange} />);

    const trigger = screen.getByRole("button");
    fireEvent.focus(trigger);
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "paste.jpg", {
      type: "image/jpeg",
    });
    fireEvent.paste(trigger, {
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

  it("clears the value when Remove is chosen", async () => {
    const onChange = vi.fn();
    render(<ImageUploadField value={URL} onChange={onChange} />);

    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /удалить|remove/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("omits Remove when there is no image", async () => {
    render(<ImageUploadField value={null} onChange={() => undefined} />);
    await openMenu();
    expect(
      screen.queryByRole("menuitem", { name: /удалить|remove/i }),
    ).toBeNull();
  });
});
