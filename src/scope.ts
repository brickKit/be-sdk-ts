/**
 * 数据范围过滤——对应 be-sdk-go 的 scope.go、be-sdk-python 的 scope.py。
 *
 * 阶段三 Task 5：`scopeOf` 从"恒不限"换成真实求解——与 `authz.ts` 的
 * `requirePermission` 同一批上线（后者验签成功后把 `scopeFromClaims`
 * 算好的 `ScopeFilter` 挂到这里说的 context 上）。
 *
 * v0.5.0（R60）：空 `deptPath` 不再是"不限"。authz 签发的真实路径恒以
 * `/` 开头（根部门也是 `/<根id>/`），空串只出现在没分部门的人身上；旧
 * 实现把它直接当前缀，`LIKE '' || '%'` 匹配所有行，是 fail-open。
 *
 * ⚠️ 与 Go/Python 版的必要差异：那两边从 `context.Context`/contextvar
 * 隐式取当前请求范围；GraphQL resolver 的 `context` 参数就是显式携带
 * 请求态的地方，所以这里改成显式传入——同一次 HTTP 请求内，GraphQL
 * 执行引擎把同一个 context 对象实例传给每一层每一个 resolver，效果上
 * 等价于 Go 的 context.Context/Python 的 ContextVar。
 */

import type { Claims } from "./jwtVerify.js";

/**
 * 没分部门（或 `deptPath` 格式异常）时 `prefix`/`exact` 的取值。
 *
 * ⚠️ 它是值层面的 fail-closed：不以 `/` 开头，任何真实路径都不会以它
 * 开头；不含 `%` `_` `\`，绑进 `LIKE $n || '%'` 不会变成通配符。所以没
 * 改过代码的下游——`LIKE` 前缀匹配、`startsWith`——什么都不命中，
 * `owner OR org` 退化成只剩本人。三份 SDK 用同一个值（Go
 * `besdk.NoDeptPath`、Python `besdk.NO_DEPT_PATH`）。
 *
 * ⚠️ 只能用来**查**，不能**写进行里**：建单时要把调用方的部门快照进
 * `dept_path` 列的，`hasDept` 为假时写空串，不要写这个哨兵。
 */
export const NO_DEPT_PATH = "!no-dept";

/**
 * 查仓储时用的数据范围过滤条件——设计书 §14.2.3 的五档求解
 * （all / dept_and_below / self_dept / self / custom）压平成一个结构，
 * 仓储方法按哪个字段决定怎么拼 WHERE。
 *
 * ⚠️ 这是一个"纯函数"的输出（§14.2.4 明文，见 `scopeFromClaims`）：五档
 * 不是 `scopeOf` 自己判断出来的，`prefix`/`exact`/`owner` 三个字段**始终**
 * 从同一份 JWT 的 `deptPath`/`sub` 填，"这次查询该用哪一档"是调用方
 * （具体某条 SQL 查询）的静态选择——它只取自己关心的那个字段，其余字段
 * 的存在与否不影响它。
 *
 * SDK 保证 `prefix`/`exact` 永不为空串：没有部门时是 `NO_DEPT_PATH`。
 * 仓储层收到空串前缀只可能是编程错误，不能当成"全部"。
 *
 * `in` 字段本次（阶段三 Task 5）不填：它对应 `mode: in` 的"自定义列表"
 * 档（如 `erp-inventory` 的仓库维度），列表从哪来是业务组件自己的数据
 * （不是 JWT 字段），要由业务组件自己的仓储层查出来后再组装，不归
 * `scopeOf` 管。
 */
export interface ScopeFilter {
  all: boolean; // all：整棵树。只有显式根标记 deptPath === "/" 时为真
  hasDept: boolean; // 这个人有没有部门归属；为假时 prefix/exact 是 NO_DEPT_PATH
  prefix: string; // dept_and_below：dept_path LIKE prefix || '%'
  exact: string; // self_dept：dept_path = exact
  owner: string; // self：owner_id = owner
  in: string[]; // custom：调用方自己填，scopeOf 不填（见上）
}

/**
 * 从一份已验签的 Claims 求 `ScopeFilter`（纯函数，判定链第 9 步）。
 *
 * - `deptPath` 为空或不以 `/` 开头：没有部门。`prefix`/`exact` 取
 *   `NO_DEPT_PATH`，`hasDept`/`all` 为假，org 维什么都不命中，只剩 owner
 *   维。格式异常的路径前缀语义不可预期，一样处理。
 * - `"/"`：整棵树的显式根标记。`all`/`hasDept` 为真，`prefix` 为 `"/"`，
 *   作为普通前缀天然匹配所有真实路径（不匹配 `dept_path` 为空串的行）。
 * - 真实路径（如 `/1/12/`）：`hasDept` 为真，原样进 `prefix`/`exact`。
 */
export function scopeFromClaims(claims: Claims): ScopeFilter {
  const dept = claims.deptPath;
  if (!dept.startsWith("/")) {
    return { all: false, hasDept: false, prefix: NO_DEPT_PATH, exact: NO_DEPT_PATH, owner: claims.sub, in: [] };
  }
  return { all: dept === "/", hasDept: true, prefix: dept, exact: dept, owner: claims.sub, in: [] };
}

/**
 * ⚠️ 用 `Symbol` 而不是普通字符串键挂在 context 对象上——避免与调用方
 * 自己的 context 字段（业务组件可能往 context 里塞别的东西）撞名。
 * 不导出：只应由 authz.ts 的 `requirePermission` 与本文件的 `scopeOf`
 * 使用，不是公开 API 的一部分（不在 index.ts 里再导出）。
 */
const SCOPE_KEY = Symbol("besdk.scope");

interface ScopeCarrier {
  [SCOPE_KEY]?: ScopeFilter;
}

/**
 * 只应由 `requirePermission` 验签成功后调用一次。不导出到 index.ts——
 * 同 be-sdk-python 的 `_set_current_scope` 一个道理，是 authz.ts 与
 * scope.ts 两个模块之间的内部协作，不是给业务组件用的。
 */
export function setCurrentScope(context: unknown, f: ScopeFilter): void {
  (context as ScopeCarrier)[SCOPE_KEY] = f;
}

/**
 * 取当前请求的数据范围。`context` 必须是经过 `requirePermission` 处理
 * 过的同一个请求的 context 对象——除 PUBLIC/AUTHENTICATED 外的字段，
 * 这个前提总是成立。
 *
 * ⚠️ 取不到时**不能**返回一个默认值：取不到身份就没有 owner，任何默认
 * 值都是在替调用方猜一个范围（各字符串字段的空串会被下游
 * `LIKE '' || '%'` 解读成"放行一切"，是 fail-**open**）。这种调用只可能
 * 是编程错误（PUBLIC 字段的 resolver 里误调了 `scopeOf`，或者压根没有经过
 * `requirePermission`）——**抛异常**，让它在测试/联调阶段就现形，而不
 * 是安静地多返回几行数据（这是全项目第三条"悄悄读到别人数据"路径的
 * 同一类风险，§14.2.6）。
 */
export function scopeOf(context: unknown): ScopeFilter {
  const f = (context as ScopeCarrier)[SCOPE_KEY];
  if (f === undefined) {
    throw new Error(
      "besdk.scopeOf: 当前 context 里没有 ScopeFilter——只能在 requirePermission 已经验过签的" +
        "字段 resolver 里调用；后台任务/事件 handler 里查数据请用 systemClient，不经过这里",
    );
  }
  return f;
}
