/**
 * 两种调用身份——对应 be-sdk-go 的 client.go、be-sdk-python 的
 * client.py。
 *
 * ⚠️ 与 Go/Python 版同样的必要差异（client.py 已经记过一次）：这里的
 * `auth` 是显式参数，不是从某个隐式上下文取——GraphQL resolver 的
 * `context` 参数本来就是显式携带请求态的地方，调用方（resolver）负责
 * 从 `context` 里取出 Authorization 传进来。
 *
 * ⚠️ 与 Go 版 `(*grpc.ClientConn, error)`/Python 版 `Channel` 的另一处
 * 差异：`@grpc/grpc-js` 生成的客户端 stub 构造函数签名是
 * `new GeneratedClient(target, credentials, options?)`——它要
 * **目标地址、凭据、可选项三样东西**，不像 Go/Python 的客户端库把它们
 * 拼进一个连接对象里就结束。所以这里返回 `{ target, credentials,
 * options }`，调用方（vendor 生成的客户端 stub）自己 `new`。
 *
 * ⚠️⚠️ **真机踩过的一处真实 bug，记在这里免得又被改回去**：最初
 * `userClient` 用 `grpc.credentials.createFromMetadataGenerator` 造一份
 * `CallCredentials`，再 `combineChannelCredentials(createInsecure(),
 * callCredentials)` 想把身份塞进凭据里——`infra-bff-mobile` 第一次真的
 * 调 mdm-customer 时直接抛 `Error: Cannot compose insecure
 * credentials`。根因：`@grpc/grpc-js` 的 `InsecureChannelCredentialsImpl.
 * compose()` **硬编码抛异常**（`channel-credentials.ts`），这是故意的
 * 安全防线——调用凭据（往往带敏感 token）不该被允许绑在未加密通道上，
 * 不是版本 bug、也不会有配置项能关掉。Python 版的 `client.py` 从一开始
 * 就没踩这个坑，因为它用的是 `UnaryUnaryClientInterceptor`（拦一次每条
 * 出站调用，往 metadata 里加一个头），根本不经过 ChannelCredentials 这
 * 条路——现在改成对应的 grpc-js **Interceptor**（`ClientOptions.
 * interceptors`），三份 SDK 的心智模型重新对齐。
 */

import * as grpc from "@grpc/grpc-js";
import { endpoint } from "./endpoint.js";

const AUTH_HEADER_KEY = "authorization";

export interface ClientDialOptions {
  target: string;
  credentials: grpc.ChannelCredentials;
  options: grpc.ClientOptions;
}

/** 把 `auth` 写进每一次出站调用的 metadata——不经过 ChannelCredentials，见上方模块文档。 */
function forwardAuthInterceptor(auth: string): grpc.Interceptor {
  return (options, nextCall) => {
    const requester: grpc.Requester = {
      start(metadata, listener, next) {
        if (auth) {
          metadata.add(AUTH_HEADER_KEY, auth);
        }
        next(metadata, listener);
      },
    };
    return new grpc.InterceptingCall(nextCall(options), requester);
  };
}

/**
 * 拨一条到 `dep` 的 gRPC 连接凭据，把 `auth`（调用方请求里的
 * Authorization）透传给下游——下游按调用者身份做数据权限过滤
 * （设计书 §14.2.3）。
 *
 * ⚠️ 只许出现在用户请求路径上（resolver 里）。查内部批量数据、后台
 * 任务一律用 {@link systemClient}——这两个名字的区别就是安全边界
 * （导读第 21 条）。
 */
export function userClient(auth: string, dep: string, extra = ""): ClientDialOptions {
  const { value: target, ok } = endpoint(dep, extra);
  if (!ok) {
    throw new Error(`besdk.userClient: 依赖 ${dep} 的地址未注入`);
  }
  return {
    target,
    credentials: grpc.credentials.createInsecure(),
    options: { interceptors: [forwardAuthInterceptor(auth)] },
  };
}

/**
 * 拨一条到 `dep` 的 gRPC 连接凭据，不透传任何调用者身份——下游会把它
 * 当成组件自身发起的调用，数据权限被绕过（设计书 §14.2.6）。只许出现
 * 在后台任务里，`make gates` 扫用户请求路径上的误用。
 */
export function systemClient(dep: string, extra = ""): ClientDialOptions {
  const { value: target, ok } = endpoint(dep, extra);
  if (!ok) {
    throw new Error(`besdk.systemClient: 依赖 ${dep} 的地址未注入`);
  }
  return { target, credentials: grpc.credentials.createInsecure(), options: {} };
}
