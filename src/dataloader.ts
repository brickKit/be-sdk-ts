/**
 * DataLoader 工厂——设计书 §6.5 强制要求的防 N+1 手段。
 *
 * ⚠️⚠️ **必须是 per-request 实例，这是本项目第 N 条"悄悄读到别人数据"
 * 的路径**（阶段三复盘、`_调研记录/03-阶段三.md` 已经记过）：DataLoader
 * 的标准用法是每个请求一个实例；做成全局单例会**跨请求缓存命中**，
 * 症状是 A 用户看到 B 用户的数据，而**单请求测试永远测不出来**。
 *
 * 所以本文件不提供"建一个全局 loader"这种东西，只提供
 * {@link createBatchGetLoader}——一个**工厂函数**，调用方必须在 Yoga
 * 的 `context` 工厂里每次请求调一次（下面的用法示例是唯一正确用法）：
 *
 * ```ts
 * createYoga({
 *   schema,
 *   context: () => ({
 *     mdmCustomerLoader: createBatchGetLoader(ids => batchGetCustomers(ids)),
 *   }),
 * })
 * ```
 *
 * **不要**把 `createBatchGetLoader` 的返回值缓存到模块级变量里跨请求
 * 复用——那正是要避免的坑。
 */

import DataLoader from "dataloader";

/**
 * 把一个"给一批 ID、按同样顺序返回同样长度结果"的 batchGet 函数包成
 * DataLoader。`batchGet` 必须遵守 DataLoader 的契约：返回数组长度与
 * 顺序都要跟 `ids` 一一对应，查不到的位置用 `null`/`undefined` 占位，
 * 不能整体少一个。
 */
export function createBatchGetLoader<K, V>(
  batchGet: (ids: readonly K[]) => Promise<ArrayLike<V | Error>>,
): DataLoader<K, V> {
  return new DataLoader<K, V>(batchGet);
}
