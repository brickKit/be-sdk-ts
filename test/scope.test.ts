/**
 * 数据范围过滤——对应 be-sdk-go 的 scope_test.go、be-sdk-python 的
 * tests/test_scope.py。
 */

import { describe, expect, it } from "vitest";
import type { Claims } from "../src/jwtVerify.js";
import * as besdk from "../src/index.js";
import {
  NO_DEPT_PATH,
  scopeFromClaims,
  scopeOf,
  setCurrentScope,
  type ScopeFilter,
} from "../src/scope.js";

function claims(sub: string, deptPath: string): Claims {
  return { sub, roles: [], deptPath, orgId: "", issuedAt: new Date(0) };
}

describe("scopeOf", () => {
  it("按 JWT 字段填三个可选字段（§14.2.4：五档不是 scopeOf 自己判断出来的）", () => {
    const context = {};
    const filter: ScopeFilter = {
      all: false,
      prefix: "/root/china/east/sh-sales",
      exact: "/root/china/east/sh-sales",
      owner: "u_zhangsan",
      in: [],
      hasDept: true,
    };
    setCurrentScope(context, filter);

    const f = scopeOf(context);

    expect(f.all).toBe(false);
    expect(f.prefix).toBe("/root/china/east/sh-sales");
    expect(f.exact).toBe("/root/china/east/sh-sales");
    expect(f.owner).toBe("u_zhangsan");
  });

  it("斜杠是整棵树的显式根标记（空 deptPath 只表示没分部门，不是根节点）", () => {
    const f = scopeFromClaims(claims("u_ceo", "/"));

    expect(f.all).toBe(true);
    expect(f.hasDept).toBe(true);
    expect(f.prefix).toBe("/");
    expect("/1/12/".startsWith(f.prefix)).toBe(true);
  });

  it("context 上没有设置过 ScopeFilter 时抛异常——不能返回零值（那是 fail-open，方向反了）", () => {
    const context = {};
    expect(() => scopeOf(context)).toThrow(/requirePermission/);
  });

  it("不同 context 对象互相隔离——不是进程级共享状态", () => {
    const contextA = {};
    const contextB = {};
    setCurrentScope(contextA, { all: false, prefix: "a", exact: "a", owner: "a", in: [], hasDept: true });

    expect(() => scopeOf(contextB)).toThrow();
    expect(scopeOf(contextA).prefix).toBe("a");
  });
});

// ── R60：没分部门的人 org 维落空，只剩本人 ─────────────────────────
describe("scopeFromClaims", () => {
  it("deptPath 为空时 org 维落空只剩本人（旧实现 prefix 为空串，LIKE '' || '%' 匹配全部）", () => {
    const f = scopeFromClaims(claims("u_x", ""));

    expect(f.all).toBe(false);
    expect(f.hasDept).toBe(false);
    expect(f.prefix).toBe(NO_DEPT_PATH);
    expect(f.exact).toBe(NO_DEPT_PATH);
    expect(f.owner).toBe("u_x");
    expect(f.in).toEqual([]);
    // 哨兵在前缀匹配里落空：真实路径、空串路径都不以它开头
    expect("/1/12/".startsWith(f.prefix)).toBe(false);
    expect("".startsWith(f.prefix)).toBe(false);
  });

  it("不以斜杠开头的 deptPath 按无部门处理（前缀语义不可预期）", () => {
    const f = scopeFromClaims(claims("u_x", "1/12/"));

    expect(f.all).toBe(false);
    expect(f.hasDept).toBe(false);
    expect(f.prefix).toBe(NO_DEPT_PATH);
    expect(f.exact).toBe(NO_DEPT_PATH);
    expect(f.owner).toBe("u_x");
  });

  it("真实部门路径原样进 prefix 和 exact", () => {
    const f = scopeFromClaims(claims("u_zhangsan", "/1/12/"));

    expect(f).toEqual({
      all: false,
      hasDept: true,
      prefix: "/1/12/",
      exact: "/1/12/",
      owner: "u_zhangsan",
      in: [],
    });
  });

  it("NO_DEPT_PATH 不以斜杠开头且不含 LIKE 通配符与默认转义符", () => {
    // 哨兵会被下游直接绑进 LIKE $n || '%'：以 / 开头就会命中真实路径，
    // 含 % / _ 会被当成通配符，含 \ 会被当成转义符。值是三份 SDK 共用的协议常量。
    expect(NO_DEPT_PATH).toBe("!no-dept");
    expect(NO_DEPT_PATH).not.toBe("");
    expect(NO_DEPT_PATH.startsWith("/")).toBe(false);
    expect(NO_DEPT_PATH).not.toContain("%");
    expect(NO_DEPT_PATH).not.toContain("_");
    expect(NO_DEPT_PATH).not.toContain("\\");
    expect(besdk.NO_DEPT_PATH).toBe(NO_DEPT_PATH);
    expect(besdk.scopeFromClaims).toBe(scopeFromClaims);
  });
});
