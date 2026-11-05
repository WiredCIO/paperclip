import { describe, expect, it } from "vitest";
import { sortCountKeys } from "../services/company-search.js";

describe("sortCountKeys", () => {
  it("serializes identically whatever order the facet rows arrived in", () => {
    const a = sortCountKeys({ "b1c1249c": 1, "14e35f1a": 1 });
    const b = sortCountKeys({ "14e35f1a": 1, "b1c1249c": 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a)).toEqual(["14e35f1a", "b1c1249c"]);
  });

  it("keeps counts and handles an empty map", () => {
    expect(sortCountKeys({ z: 3, a: 7 })).toEqual({ a: 7, z: 3 });
    expect(sortCountKeys({})).toEqual({});
  });
});
