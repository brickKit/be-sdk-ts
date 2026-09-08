/**
 * 数据范围过滤——对应 be-sdk-go 的 scope_test.go、be-sdk-python 的
 * tests/test_scope.py。
 */

import { describe, expect, it } from "vitest";
import { scopeOf, setCurrentScope, type ScopeFilter } from "../src/scope.js";

describe("scopeOf", () => {
  it("按 JWT 字段填三个可选字段（§14.2.4：五档不是 scopeOf 自己判断出来的）", () => {
    const context = {};
    const filter: ScopeFilter = {
      all: false,
      prefix: "/root/china/east/sh-sales",
      exact: "/root/china/east/sh-sales",
      owner: "u_zhangsan",
      in: [],
    };
    setCurrentScope(context, filter);

    const f = scopeOf(context);

    expect(f.all).toBe(false);
    expect(f.prefix).toBe("/root/china/east/sh-sales");
    expect(f.exact).toBe("/root/china/east/sh-sales");
    expect(f.owner).toBe("u_zhangsan");
  });

  it("部门树根节点自然得到 all（不是特判出来的）", () => {
    const context = {};
    setCurrentScope(context, { all: true, prefix: "", exact: "", owner: "u_ceo", in: [] });

    expect(scopeOf(context).all).toBe(true);
  });

  it("context 上没有设置过 ScopeFilter 时抛异常——不能返回零值（那是 fail-open，方向反了）", () => {
    const context = {};
    expect(() => scopeOf(context)).toThrow(/requirePermission/);
  });

  it("不同 context 对象互相隔离——不是进程级共享状态", () => {
    const contextA = {};
    const contextB = {};
    setCurrentScope(contextA, { all: false, prefix: "a", exact: "a", owner: "a", in: [] });

    expect(() => scopeOf(contextB)).toThrow();
    expect(scopeOf(contextA).prefix).toBe("a");
  });
});
