/**
 * 组件地址解析——对应 be-sdk-go 的 endpoint.go、be-sdk-python 的
 * endpoint.py，逻辑逐字对应，不许分叉。
 * v1 起只保留 `envName`；读值与剥 scheme 搬到 `Config.endpoint()`。
 */

export function envName(dep: string, extra: string): string {
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
