import { describe, expect, it } from "vitest";
import { renderWithIntl as render } from "@/test/render-with-intl";
import { Dialog, DialogContent } from "./dialog";

describe("DialogContent", () => {
  it("constrains DialogContent height and enables vertical overflow", () => {
    render(
      <Dialog open>
        <DialogContent>body</DialogContent>
      </Dialog>,
    );
    // Portals to document.body — query outside the RTL container.
    const content = document.querySelector("[data-slot='dialog-content']");
    expect(content).not.toBeNull();
    expect(content!.className).toMatch(/overflow-y-auto/);
    expect(content!.className).toMatch(/max-h-/);
  });
});
