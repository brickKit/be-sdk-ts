/**
 * 数据范围过滤——对应 be-sdk-go 的 scope.go、be-sdk-python 的 scope.py。
 * 同 authz.ts，先按阶段二 be-sdk-go 当前的形状写（签名真实、恒不限），
 * Task 5 一起换成真实求解（理由见 authz.ts 模块文档）。
 */

export interface ScopeFilter {
  all: boolean; // all：不限
  prefix: string; // dept_and_below：dept_path LIKE prefix || '%'
  exact: string; // self_dept：dept_path = exact
  owner: string; // self：owner_id = owner
  in: string[]; // custom：dept_path LIKE ANY(...)
}

/**
 * 取当前请求的数据范围。阶段三 Task 2 恒返回不限——JWT 里的
 * dept_path/sub 要等 Task 5（`infra-authz` 上线）才有真实的身份链路
 * 可解。签名先定型，调用方现在就按它接线；Task 5 只改这一个函数的
 * 实现，不改调用点。
 *
 * ⚠️ 与 Go/Python 版的必要差异：那两边从 `context.Context`/contextvar
 * 隐式取当前请求范围；GraphQL resolver 的 `context` 参数就是显式携带
 * 请求态的地方，所以这里改成显式传入。
 */
export function scopeOf(_context: unknown): ScopeFilter {
  return { all: true, prefix: "", exact: "", owner: "", in: [] };
}
