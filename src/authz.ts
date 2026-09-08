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
 * 阶段三 Task 5：判定本体从 fail-closed stub 换成真实判定，与
 * be-sdk-go/be-sdk-python 同一批上线，判定链逐字对应
 * （设计书 §14.1.6 第 3 步、§14.1.9）。⚠️ 另一处必要差异（除了上面
 * 那条注册方式）：Go/Python 从 `context.Context`/contextvar 隐式取
 * "当前请求"，这里改成 GraphQL resolver 的 `context` 参数显式携带——
 * 见 scope.ts 的同款说明。
 */

import type { GraphQLFieldResolver } from "graphql";
import { createGraphQLError } from "graphql-yoga";
import type { Logger } from "pino";
import { BundleCache, startBundlePoller } from "./bundle.js";
import { JWTVerifier, type Claims } from "./jwtVerify.js";
import type { Runtime } from "./runtime.js";
import { setCurrentScope } from "./scope.js";

export type PermKey = string;

/**
 * PUBLIC 是"显式公开"，不是"省略"。调用点必须显式传 `PUBLIC` 才能通过
 * `make gates` 的裸 resolver 扫描，不存在"忘了传权限键"这种失败模式
 * （设计书 §14.1.7、导读第 23 条）。
 */
export const PUBLIC: PermKey = "";

/**
 * AUTHENTICATED 是"已登录即可，不需要具体权限键"这一档（阶段三 Task 4
 * 实现 infra-authz 时发现的真实缺口：`myPermissions` 这类字段任何登录
 * 用户都该能查，套一个具体权限键反而是画蛇添足）。⚠️ 仍然会验 JWT
 * 签名与 stale_since，只是跳过 bundle map 的权限键查找这一步——与
 * be-sdk-go 的 `Authenticated`/be-sdk-python 的 `AUTHENTICATED` 逐字
 * 对应。
 */
export const AUTHENTICATED: PermKey = "__authenticated__";

/**
 * ⚠️ **必须用 `createGraphQLError` 造错误，不能是裸 `Error` 子类**——
 * 这是真机验证过的一处 Yoga 行为：默认开启的 `maskedErrors` 只放行
 * `instanceof GraphQLError` 的错误（`isOriginalGraphQLError`），裸
 * `Error`（哪怕自定义了 `name`/`statusCode`）会被替换成通用的
 * "Unexpected error."，客户端完全看不出是权限问题还是真的挂了。
 * 401/403/503 都属于"该让调用方看见的正常业务语义"，不是要隐藏的内部
 * 错误——真正的意外错误（未捕获异常、下游连接失败）才应该被掩盖。
 *
 * `extensions.http.status`/`extensions.http.headers` 是真机核对过的
 * Yoga 行为（`graphql-yoga/cjs/error.js` 的 `getResponseInitByRespectingErrors`）
 * ：单个错误的这两个字段会被合并进真实的 HTTP 响应状态码/响应头，
 * 不只是 GraphQL 结果体里的一个字段——WWW-Authenticate 这类头能真的
 * 传给客户端就是靠这条。
 */
function httpError(
  message: string,
  status: number,
  opts: { code: string; headers?: Record<string, string> },
): never {
  throw createGraphQLError(message, {
    extensions: { code: opts.code, http: { status, headers: opts.headers } },
  });
}

function forbidden(message: string): never {
  httpError(message, 403, { code: "FORBIDDEN" });
}

/**
 * 权限判定的进程级状态——由 `runStandalone` 在启动时装配一次（同
 * otel provider 那一类"只能有一份"的东西，设计书 §12.5.2）。两者任一
 * 为 `null` 都代表这个组件没配 `iamJwksUrl`/`authzBundleUrl`，此时任何
 * 非 `PUBLIC` 权限键一律 fail-closed 403——这是阶段二遗留的默认状态，
 * 阶段三给这两项配置赋值之前，行为不变。
 */
let authzVerifier: JWTVerifier | null = null;
let authzBundle: BundleCache | null = null;

/** 只应由 `runStandalone` 调用一次。 */
export function setAuthzRuntime(verifier: JWTVerifier | null, bundle: BundleCache | null): void {
  authzVerifier = verifier;
  authzBundle = bundle;
}

/**
 * 从 `rt.config` 读 `iamJwksUrl`/`authzBundleUrl`，装配 JWT 验签器与
 * bundle 轮询——`runStandalone` 专用，模块代码不调用。两项配置任一
 * 缺失都返回 `null`，调用方（`requirePermission`）据此退化成
 * fail-closed stub，不阻断组件启动（§14.1.9：authz 不可达不该拖累
 * 组件本身）。
 */
export function setupAuthzRuntime(
  rt: Pick<Runtime, "config" | "logger">,
): { verifier: JWTVerifier | null; bundle: BundleCache | null } {
  const logger = rt.logger;

  let verifier: JWTVerifier | null = null;
  const { value: jwksUrl, ok: hasJwksUrl } = rt.config.string("iamJwksUrl");
  if (hasJwksUrl && jwksUrl !== "") {
    try {
      verifier = new JWTVerifier(jwksUrl);
    } catch (err) {
      // ⚠️ 不抛出：JWKS URL 本身不合法这类配置错误记日志即可定位，
      // 不阻断组件启动（同 Go/Python 版判据）。
      logger.error({ err }, "初始化 JWT 验签器失败，非 PUBLIC/AUTHENTICATED 权限键将 fail-closed");
    }
  } else {
    logger.info("未配置 iamJwksUrl，非 PUBLIC/AUTHENTICATED 权限键将 fail-closed（阶段二遗留行为）");
  }

  let bundle: BundleCache | null = null;
  const { value: bundleUrl, ok: hasBundleUrl } = rt.config.string("authzBundleUrl");
  if (hasBundleUrl && bundleUrl !== "") {
    bundle = startBundlePoller(bundleUrl, logger);
  } else {
    logger.info("未配置 authzBundleUrl，具体权限键判定将始终 503");
  }

  return { verifier, bundle };
}

function bearerToken(context: unknown): string | undefined {
  const request = (context as { request?: Request } | null | undefined)?.request;
  const header = request?.headers.get("authorization") ?? request?.headers.get("Authorization");
  const prefix = "Bearer ";
  if (!header || !header.startsWith(prefix)) return undefined;
  const token = header.slice(prefix.length).trim();
  return token === "" ? undefined : token;
}

/** jwt.iat 与 stale_since 比较时的容忍余量——跨机器的毫秒级时钟偏差会造成一次多余的刷新，留几秒余量消掉它（设计书 §14.1.6）。 */
const STALE_TIME_SKEW_SECONDS = 5;

function isStale(claims: Claims, bundle: BundleCache | null): boolean {
  if (bundle === null) return false;
  const since = bundle.staleSinceFor(claims.sub);
  if (since === 0) return false;
  return claims.issuedAt.getTime() / 1000 < since - STALE_TIME_SKEW_SECONDS;
}

/**
 * 给一个字段 resolver 包一层权限判定。判定链（设计书 §14.1.6 第 3
 * 步、§14.1.9），与 be-sdk-go 的 `RequirePermission`/be-sdk-python 的
 * `require_permission` 逐字对应：
 *
 * 1. `PUBLIC`：直接放行，不验签——`/healthz` 这类必须匿名可达的端点
 *    靠这条（GraphQL 侧对应"这个字段谁都能查"）。
 * 2. 验签 JWT（本地，JWKS 从 `iamJwksUrl` 来）；没配置时退化成阶段二
 *    的 fail-closed stub：非 `PUBLIC` 一律 403，行为对已经写好、还没
 *    升级 configSchema 的组件保持不变。
 * 3. `jwt.iat < stale_since[sub]` → 401 `token_stale`（有界列表，
 *    §14.1.6）。
 * 4. `AUTHENTICATED`：验签过、不 stale 就放行，不查权限键。
 * 5. 具体权限键：bundle 从没连上过 authz → 503（不是 403，语义更准，
 *    §14.1.9）；连上过就在纯并集展开后的权限键集合里查，查不到 403。
 */
export function requirePermission<TSource, TContext, TArgs>(
  perm: PermKey,
  resolver: GraphQLFieldResolver<TSource, TContext, TArgs>,
): GraphQLFieldResolver<TSource, TContext, TArgs> {
  return (source, args, context, info) => {
    if (perm === PUBLIC) {
      return resolver(source, args, context, info);
    }

    if (authzVerifier === null) {
      // 阶段二遗留的 fail-closed stub：没有真实判定能力时，非 PUBLIC
      // 一律拒绝——安全机制的默认值只能 fail-closed。
      forbidden("权限判定尚未配置（iamJwksUrl 未注入）");
    }

    const token = bearerToken(context);
    if (token === undefined) {
      httpError("缺少或格式不对的 Authorization", 401, { code: "UNAUTHENTICATED" });
    }

    return (async () => {
      let claims: Claims;
      try {
        claims = await authzVerifier!.verify(token);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return httpError(`token 无效: ${message}`, 401, { code: "UNAUTHENTICATED" });
      }

      if (isStale(claims, authzBundle)) {
        return httpError("token_stale", 401, {
          code: "UNAUTHENTICATED",
          headers: { "WWW-Authenticate": 'Bearer error="token_stale"' },
        });
      }

      // ⚠️ 直接挂在 context 对象上，不是另起一份存储——scopeOf 收的是
      // 同一个 context 引用，GraphQL 执行一次请求期间所有 resolver
      // （无论层级）共享同一个 context 实例，等价于 Go 的
      // context.Context/Python 的 ContextVar 在同一次请求内的效果。
      setCurrentScope(context, {
        all: claims.deptPath === "",
        prefix: claims.deptPath,
        exact: claims.deptPath,
        owner: claims.sub,
        in: [],
      });

      if (perm === AUTHENTICATED) {
        return resolver(source, args, context, info);
      }

      const bundle = authzBundle;
      if (bundle === null || !bundle.hasEverFetched()) {
        return httpError("权限判定尚未就绪（authz 从启动到现在还没能连上过）", 503, {
          code: "SERVICE_UNAVAILABLE",
        });
      }
      if (!bundle.hasPermission(claims.roles, perm)) {
        forbidden("无权限");
      }

      return resolver(source, args, context, info);
    })();
  };
}
