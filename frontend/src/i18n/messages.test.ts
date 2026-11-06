import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import ru from "../../messages/ru.json";

type Json = { [key: string]: string | Json };

function keyPaths(value: Json, prefix = ""): string[] {
  return Object.entries(value)
    .flatMap(([key, child]) =>
      typeof child === "string"
        ? [`${prefix}${key}`]
        : keyPaths(child, `${prefix}${key}.`),
    )
    .sort();
}

function icuVariables(message: string): string[] {
  return [...message.matchAll(/\{(\w+)[,}]/g)]
    .map((match) => match[1])
    .sort();
}

describe("message catalogs", () => {
  it("have the same keys", () => {
    expect(keyPaths(ru as Json)).toEqual(keyPaths(en as Json));
  });

  it("use the same ICU variables for every key", () => {
    const paths = keyPaths(en as Json);
    for (const path of paths) {
      const lookup = (catalog: Json) =>
        path
          .split(".")
          .reduce<string | Json>(
            (node, part) => (node as Json)[part],
            catalog,
          ) as string;
      expect(icuVariables(lookup(ru as Json)), path).toEqual(
        icuVariables(lookup(en as Json)),
      );
    }
  });
});
