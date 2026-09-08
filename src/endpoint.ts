/**
 * 组件地址解析——对应 be-sdk-go 的 endpoint.go、be-sdk-python 的
 * endpoint.py，逻辑逐字对应，不许分叉。
 */

function envName(dep: string, extra: string): string {
  // 把组件 ID 推导成平台注入的变量名前缀。
  //
  // ⚠️ 规则必须与平台的 manifest.EnvPrefix 逐字一致：只把 / 与 - 换成 _，
  // 然后全大写。不要多加任何替换规则——组件 ID 的正则里不允许出现点号，
  // 多写一条会让读的人以为 ID 里可能有点号。
  //
  //   "mdm/customer" + ""                 -> "MDM_CUSTOMER_ENDPOINT"
  //   "erp/inventory" + "grpc"            -> "ERP_INVENTORY_GRPC_ENDPOINT"
  const p = dep.replace(/[/-]/g, "_").toUpperCase();
  return extra ? `${p}_${extra.toUpperCase()}_ENDPOINT` : `${p}_ENDPOINT`;
}

export interface EndpointResult {
  value: string;
  ok: boolean;
}

/**
 * 读 `*_ENDPOINT` 并剥掉 scheme。
 *
 * ⚠️ 平台注入的值恒为 `http://` 开头，额外端口也一样——没有 `grpc://`
 * 这种东西。直接把带 scheme 的值传给 gRPC 客户端会连不上，而报错信息
 * 指向名称解析，非常难联想到是这里。所以剥 scheme 这件事全项目只写在
 * 这一个函数里（导读第 1 条）。
 *
 * ⚠️ 弱依赖缺失时那个变量根本不存在，不是空字符串——这是平台刻意的设计
 * （§3.6）。返回 `{ value, ok }`，调用方必须显式判断 `ok`。
 */
export function endpoint(dep: string, extra = ""): EndpointResult {
  const v = process.env[envName(dep, extra)];
  if (!v) {
    return { value: "", ok: false };
  }
  const stripped = v.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return { value: stripped, ok: true };
}

/** 用于强依赖：缺失即抛异常（强依赖缺失时平台本来就会阻断启动）。 */
export function mustEndpoint(dep: string, extra = ""): string {
  const { value, ok } = endpoint(dep, extra);
  if (!ok) {
    throw new Error(`强依赖 ${dep} 的 ${envName(dep, extra)} 未注入`);
  }
  return value;
}

/**
 * 读 `STORAGE_ENDPOINT` 并**加上** scheme，返回完整 URL。
 *
 * ⚠️ 与 {@link endpoint} 方向相反。`STORAGE_ENDPOINT` 是平台注入的资源
 * 变量，值是裸 `host:port`；而 S3 SDK 要一个完整 URL。两个函数必须
 * 分开——共用一个必然有一边错（导读第 12 条）。
 */
export function storageEndpoint(secure = false): EndpointResult {
  const v = process.env.STORAGE_ENDPOINT;
  if (!v) {
    return { value: "", ok: false };
  }
  return { value: `${secure ? "https" : "http"}://${v}`, ok: true };
}
