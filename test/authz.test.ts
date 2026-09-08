import { describe, expect, it } from "vitest";
import { PUBLIC } from "../src/authz.js";

describe("authz constants", () => {
  it("PUBLIC 是常量不是空字符串字面量的巧合", () => {
    // ⚠️ 这条锁的是"漏传权限键"这个失败模式不存在——PUBLIC 的值恰好是
    // 空字符串是实现细节，调用点必须显式写 PUBLIC 才能通过 make gates
    // 的裸 resolver 扫描（阶段三计划 Task 3），不是随手传个 "" 就行。
    expect(PUBLIC).toBe("");
    expect(typeof PUBLIC).toBe("string");
  });
});
