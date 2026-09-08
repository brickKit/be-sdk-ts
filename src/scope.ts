/**
 * 数据范围过滤——对应 be-sdk-go 的 scope.go、be-sdk-python 的 scope.py。
 *
 * 阶段三 Task 5：`scopeOf` 从"恒不限"换成真实求解——与 `authz.ts` 的
 * `requirePermission` 同一批上线（后者验签成功后把算好的
 * `ScopeFilter` 挂到这里说的 context 上）。
 *
 * ⚠️ 与 Go/Python 版的必要差异：那两边从 `context.Context`/contextvar
 * 隐式取当前请求范围；GraphQL resolver 的 `context` 参数就是显式携带
 * 请求态的地方，所以这里改成显式传入——同一次 HTTP 请求内，GraphQL
 * 执行引擎把同一个 context 对象实例传给每一层每一个 resolver，效果上
 * 等价于 Go 的 context.Context/Python 的 ContextVar。
 */

/**
 * 查仓储时用的数据范围过滤条件——设计书 §14.2.3 的五档求解
 * （all / dept_and_below / self_dept / self / custom）压平成一个结构，
 * 仓储方法按哪个字段非空决定怎么拼 WHERE。
 *
 * ⚠️ 这是一个"纯函数"的输出（§14.2.4 明文）：五档不是 `scopeOf` 自己
 * 判断出来的，`prefix`/`exact`/`owner` 三个字段**始终**从同一份 JWT
 * 的 `deptPath`/`sub` 填，"这次查询该用哪一档"是调用方（具体某条 SQL
 * 查询）的静态选择——它只取自己关心的那个字段，其余字段的存在与否不
 * 影响它。`in` 字段本次（阶段三 Task 5）不填：它对应 `mode: in` 的
 * "自定义列表"档（如 `erp-inventory` 的仓库维度），列表从哪来是业务
 * 组件自己的数据（不是 JWT 字段），要由业务组件自己的仓储层查出来后
 * 再组装，不归 `scopeOf` 管。
 */
export interface ScopeFilter {
  all: boolean; // all：不限。deptPath 为空（如坐在部门树根节点）时天然成立，不是特判出来的
  prefix: string; // dept_and_below：dept_path LIKE prefix || '%'
  exact: string; // self_dept：dept_path = exact
  owner: string; // self：owner_id = owner
  in: string[]; // custom：调用方自己填，scopeOf 不填（见上）
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
 * ⚠️ 取不到时**不能**返回一个"看起来安全"的默认值：§14.2.4 的 SQL
 * 约定是"空字符串表示不限"（`@scope_prefix = ''` 表示不限），零值的
 * `prefix`/`owner` 都是空字符串——那会被下游 SQL 解读成"放行一切"，
 * 方向反了，是 fail-**open** 不是 fail-closed。这种调用只可能是编程
 * 错误（PUBLIC 字段的 resolver 里误调了 `scopeOf`，或者压根没有经过
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
