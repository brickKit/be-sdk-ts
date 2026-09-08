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
 * `new GeneratedClient(target, credentials)`——它要**目标地址和凭据
 * 两样东西**，不像 Go/Python 的客户端库把两者拼进一个连接对象里就
 * 结束。所以这里返回 `{ target, credentials }`，调用方（vendor 生成的
 * 客户端 stub）自己 `new`。两个函数返回同一种形状，不因为
 * 透不透传身份而长得不一样。
 */

import * as grpc from "@grpc/grpc-js";
import { endpoint } from "./endpoint.js";

const AUTH_HEADER_KEY = "authorization";

export interface ClientDialOptions {
  target: string;
  credentials: grpc.ChannelCredentials;
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
  const callCredentials = grpc.credentials.createFromMetadataGenerator(
    (_options, callback) => {
      const metadata = new grpc.Metadata();
      if (auth) {
        metadata.set(AUTH_HEADER_KEY, auth);
      }
      callback(null, metadata);
    },
  );
  return {
    target,
    credentials: grpc.credentials.combineChannelCredentials(
      grpc.credentials.createInsecure(),
      callCredentials,
    ),
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
  return { target, credentials: grpc.credentials.createInsecure() };
}
