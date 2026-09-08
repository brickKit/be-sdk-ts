/**
 * 权限键 resolver 包装——对应 be-sdk-go 的 authz.go、be-sdk-python 的
 * authz.py。
 *
 * ⚠️⚠️ **这是三份 SDK 里唯一一处不能照抄另外两份签名的地方，设计书
 * §5.10 与阶段三计划 Task 3 都点名了这一点**：Go/Python 版的判据是
 * "路由注册函数强制要求一个权限键参数"（`besdk.GET(r, path, perm, h)`）
 * ——这个判据成立的前提是"每个接口对应一次路由注册调用"，而 GraphQL
 * 没有路由，只有**字段**。所以这里把判据平移成"**每个字段 resolver
 * 必须经过 requirePermission 包装**"，形状变了，但"漏传权限键就该在
 * 某个机械检查上现形"这条精神不变——`make gates` 的裸 resolver 扫描
 * （阶段三计划 Task 3）负责这一半，本文件只提供包装工具本身。
 *
 * ⚠️ 与 authz.py 同样的偏离，同样的理由：判定本体现在仍是 be-sdk-go
 * **当前**（阶段二）的 fail-closed stub 形状——PUBLIC 放行，其余一律
 * 拒绝。真实的 bundle 轮询是 Task 5（`infra-authz` 建成后）与三个
 * `be-sdk-*` 一起补，这里不提前抢跑。
 */

import type { GraphQLFieldResolver } from "graphql";
import { createGraphQLError } from "graphql-yoga";

export type PermKey = string;

/**
 * PUBLIC 是"显式公开"，不是"省略"。调用点必须显式传 `PUBLIC` 才能通过
 * `make gates` 的裸 resolver 扫描，不存在"忘了传权限键"这种失败模式
 * （设计书 §14.1.7、导读第 23 条）。
 */
export const PUBLIC: PermKey = "";

/**
 * ⚠️ **必须用 `createGraphQLError` 造错误，不能是裸 `Error` 子类**——
 * 这是真机验证过的一处 Yoga 行为：默认开启的 `maskedErrors` 只放行
 * `instanceof GraphQLError` 的错误（`isOriginalGraphQLError`），裸
 * `Error`（哪怕自定义了 `name`/`statusCode`）会被替换成通用的
 * "Unexpected error."，客户端完全看不出是权限问题还是真的挂了。
 * 403 属于"该让调用方看见的正常业务语义"，不是要隐藏的内部错误——
 * 这条区分本身就是判据：真正的意外错误（未捕获异常、下游连接失败）
 * 才应该被掩盖，"你没有这个权限"不该被掩盖。
 */
function forbidden(message: string): never {
  throw createGraphQLError(message, {
    extensions: { code: "FORBIDDEN", http: { status: 403 } },
  });
}

/**
 * 给一个字段 resolver 包一层权限判定。阶段三 Task 2 是 fail-closed
 * stub：`PUBLIC` 放行，其余一律拒绝——真实判定要等 Task 5 换成进程内
 * bundle map 查找，签名不变，调用方（各组件的 resolver map）不用跟着改。
 */
export function requirePermission<TSource, TContext, TArgs>(
  perm: PermKey,
  resolver: GraphQLFieldResolver<TSource, TContext, TArgs>,
): GraphQLFieldResolver<TSource, TContext, TArgs> {
  return (source, args, context, info) => {
    if (perm !== PUBLIC) {
      forbidden("权限判定尚未实现（阶段三 Task 5 之前，非 PUBLIC 字段一律拒绝）");
    }
    return resolver(source, args, context, info);
  };
}
