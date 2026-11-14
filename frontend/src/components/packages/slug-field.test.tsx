import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { messages, renderWithIntl as render } from "@/test/render-with-intl";
import { SlugField } from "./slug-field";
import type { SlugAvailability } from "./use-slug-availability";

const slugMessages = messages.en.Slug;
const idle: SlugAvailability = { state: "idle", result: null, retry: () => {} };

function fieldProps(
  availability: SlugAvailability,
  extra: Partial<ComponentProps<typeof SlugField>> = {},
): ComponentProps<typeof SlugField> {
  return {
    id: "slug",
    label: "Slug",
    value: "hero",
    onChange: () => {},
    availability,
    retryLabel: "Check again",
    ...extra,
  };
}

describe("SlugField", () => {
  it("lowercases what the user types before reporting it", () => {
    const onChange = vi.fn();
    render(<SlugField {...fieldProps(idle, { onChange })} />, {
      locale: "en",
    });
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "Hero_2D" },
    });
    expect(onChange).toHaveBeenCalledWith("hero_2d");
  });

  it("shows the shared hint for the current state", () => {
    render(<SlugField {...fieldProps({ ...idle, state: "taken" })} />, {
      locale: "en",
    });
    expect(screen.getByText(slugMessages.taken)).toBeDefined();
  });

  it("offers a retry only after a failed check", () => {
    const retry = vi.fn();
    render(<SlugField {...fieldProps({ ...idle, state: "error", retry })} />, {
      locale: "en",
    });
    expect(screen.getByText(slugMessages.checkFailed)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps the workshop note out until the room slug is free", () => {
    const note = "Already used in the workshop";
    const { rerender } = render(
      <SlugField
        {...fieldProps({ ...idle, state: "taken" }, { takenInWorkshop: note })}
      />,
      { locale: "en" },
    );
    expect(screen.queryByText(note)).toBeNull();

    rerender(
      <SlugField
        {...fieldProps({ ...idle, state: "available" }, { takenInWorkshop: note })}
      />,
    );
    expect(screen.getByText(note)).toBeDefined();
  });
});
