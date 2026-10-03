import { describe, expect, it } from "vitest";
import { compareMigrations } from "../../../src/runtime/database.js";

describe("compareMigrations (P1.4, P1.8)", () => {
  const image = ["0001_a", "0002_b"];
  it("is ok when the schema has exactly the image's migrations and platform version", () => expect(compareMigrations(image, image, 1)).toBe("ok"));
  it("is behind when a migration or the platform migration has not run", () => {
    expect(compareMigrations(["0001_a"], image, 1)).toBe("behind");
    expect(compareMigrations(image, image, undefined)).toBe("behind");
  });
  it("is ahead when the schema knows a migration this image does not", () => {
    expect(compareMigrations([...image, "0003_c"], image, 1)).toBe("ahead");
    expect(compareMigrations(image, image, 2)).toBe("ahead");
  });
});
