import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkshopTags } from "./use-workshop-tags";
import { TagInput } from "./tag-input";

vi.mock("./use-workshop-tags", () => ({
  useWorkshopTags: vi.fn(),
}));

function renderInput(value: string[] = []) {
  const onChange = vi.fn();
  render(<TagInput value={value} onChange={onChange} />);
  const input = screen.getByRole("combobox") as HTMLInputElement;
  return { onChange, input };
}

beforeEach(() => {
  vi.mocked(useWorkshopTags).mockReturnValue({
    tags: [
      { tag: "gameplay", count: 12 },
      { tag: "hero", count: 3 },
      { tag: "2d", count: 1 },
    ],
    loading: false,
  });
});

describe("TagInput", () => {
  it("adds a normalized tag on Enter", () => {
    const { onChange, input } = renderInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Newtag" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(["newtag"]);
  });

  it("adds a tag on comma", () => {
    const { onChange, input } = renderInput();
    fireEvent.change(input, { target: { value: "hero" } });
    fireEvent.keyDown(input, { key: "," });
    expect(onChange).toHaveBeenCalledWith(["hero"]);
  });

  it("commits a valid draft on blur", () => {
    const { onChange, input } = renderInput();
    fireEvent.change(input, { target: { value: "newtag" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(["newtag"]);
  });

  it("adds an existing suggestion on click with its frequency", async () => {
    const { onChange, input } = renderInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "game" } });
    const option = await screen.findByRole("option", { name: /gameplay/ });
    expect(option.textContent).toContain("12 пакетов");
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(["gameplay"]);
  });

  it("moves the active option with the arrow keys", async () => {
    const { onChange, input } = renderInput();
    fireEvent.focus(input);
    await screen.findByRole("option", { name: /gameplay/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["hero"]);
  });

  it("offers to create an unknown tag", async () => {
    const { onChange, input } = renderInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "roguelike" } });
    fireEvent.click(
      await screen.findByRole("option", { name: "Создать „roguelike“" }),
    );
    expect(onChange).toHaveBeenCalledWith(["roguelike"]);
  });

  it("keeps an invalid draft and shows the format hint", () => {
    const { onChange, input } = renderInput();
    fireEvent.change(input, { target: { value: "Привет!" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("Привет!");
    expect(
      screen.getByText("Латиница, цифры, _ и -, до 32 символов."),
    ).toBeTruthy();
  });

  it("ignores a duplicate tag", () => {
    const { onChange, input } = renderInput(["hero"]);
    fireEvent.change(input, { target: { value: "hero" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("caps the tag count", () => {
    const ten = Array.from({ length: 10 }, (_, index) => `tag${index}`);
    const { onChange, input } = renderInput(ten);
    fireEvent.change(input, { target: { value: "extra" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText("Можно добавить не больше 10 тегов."),
    ).toBeTruthy();
  });

  it("removes the last tag on Backspace in an empty field", () => {
    const { onChange, input } = renderInput(["a", "b"]);
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onChange).toHaveBeenCalledWith(["a"]);
  });

  it("removes a tag with its button", () => {
    const { onChange } = renderInput(["a", "b"]);
    fireEvent.click(screen.getByRole("button", { name: "Удалить тег b" }));
    expect(onChange).toHaveBeenCalledWith(["a"]);
  });

  it("excludes selected tags from suggestions", async () => {
    const { input } = renderInput(["hero"]);
    fireEvent.focus(input);
    await screen.findByRole("option", { name: /gameplay/ });
    expect(
      screen.queryByRole("option", { name: /^hero/ }),
    ).toBeNull();
  });

  it("shows loading text but still accepts free input", async () => {
    vi.mocked(useWorkshopTags).mockReturnValue({ tags: [], loading: true });
    const { onChange, input } = renderInput();
    fireEvent.focus(input);
    expect(screen.getByText("Загружаем теги…")).toBeTruthy();
    fireEvent.change(input, { target: { value: "custom" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["custom"]);
  });
});
