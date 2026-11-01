import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

describe("cli", () => {
  it("saca exit 3 para comand unknown", async () =>
    expect(await main(["nonsense"])).toBe(3));
  it("saca exit 0 para --help", async () =>
    expect(await main(["--help"])).toBe(0));
});
