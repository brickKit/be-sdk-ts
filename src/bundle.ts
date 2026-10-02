/**
 * GET /authz/bundle 轮询——对应 be-sdk-go 的 bundle.go、be-sdk-python 的
 * bundle.py。
 *
 * "组件里没有任何一张权限表"这条在这里成立：这只是一份进程内缓存，
 * 不落库、不进迁移（设计书 §14.1.4）。⚠️ 这是全组件唯一一份、由
 * `runStandalone` 在启动时创建一次，`requirePermission` 只读它。
 */

import type { Logger } from "pino";

/** 15 秒条件轮询间隔（设计书 §14.1.4/§14.1.6：生效时延全部 ~15 秒，就是这个数）。 */
export const BUNDLE_POLL_INTERVAL_MS = 15_000;

/** 首次拉取失败后的第一次重试间隔。首次成功之前按它翻倍退避（封顶 `BUNDLE_POLL_INTERVAL_MS`），见 `startBundlePoller`。 */
export const BUNDLE_FIRST_RETRY_DELAY_MS = 500;

/** 把退避间隔翻倍，封顶轮询间隔。 */
export function nextBundleRetryDelay(ms: number): number {
  return Math.min(ms * 2, BUNDLE_POLL_INTERVAL_MS);
}

interface BundleWireFormat {
  roles?: Record<string, string[]>;
  stale_since?: Record<string, number>;
}

/**
 * ⚠️ 单线程 JS 事件循环下不需要任何锁——`fetchOnce` 末尾对
 * `this.roles`/`this.staleSince`/`this.etag`/`this.everFetched` 的赋值
 * 之间没有 `await`，不可能被打断到一半（同 be-sdk-python 的 `BundleCache`
 * 不用 `asyncio.Lock` 一个道理）。
 */
export class BundleCache {
  private roles: Record<string, string[]> = {};
  private staleSince: Record<string, number> = {};
  private etag = "";
  private everFetched = false; // 区分"还没连上过 authz"与"连上了但暂时没有任何角色"

  /** 区分"authz 从启动到现在一次都没连上过"（§14.1.9：业务请求该返 503）与"连上过、只是这个角色恰好没有这条权限"（该返 403）。 */
  hasEverFetched(): boolean {
    return this.everFetched;
  }

  /** 把 roles 按纯并集展开，判 perm 在不在里面（设计书 §14.1.3：纯并集，无 Deny）。 */
  hasPermission(roles: string[], perm: string): boolean {
    for (const role of roles) {
      if ((this.roles[role] ?? []).includes(perm)) return true;
    }
    return false;
  }

  /** 取 sub 在有界列表里的时间戳，不存在返回 0（永不 stale）。 */
  staleSinceFor(sub: string): number {
    return this.staleSince[sub] ?? 0;
  }

  /**
   * 单次条件 GET。单次失败（网络抖动、authz 重启中）只记日志、沿用
   * 内存里最后一份 bundle 继续跑——这是 §14.1.9 的 fail-static：一个
   * 授权服务抖动不该让使用它的组件同时拒绝所有请求。
   *
   * 不是 private：测试直接调它验证单次行为（同 Go/Python 版把等价方法
   * 留给测试直接触发的做法）。`startBundlePoller` 的循环调的是
   * `tryFetchOnce`，它多返回一个"这次是否拿到了可用的 bundle"。
   */
  async fetchOnce(url: string, logger: Logger): Promise<void> {
    await this.tryFetchOnce(url, logger);
  }

  /** 拉一次，返回这次是否拿到了可用的 bundle（200 解析成功，或 304 沿用已有的）。失败时只记日志、内存里的旧内容不动。 */
  async tryFetchOnce(url: string, logger: Logger): Promise<boolean> {
    const headers: Record<string, string> = {};
    if (this.etag) headers["If-None-Match"] = this.etag;

    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      logger.warn({ err }, "拉取 authz bundle 失败，沿用内存里已有的旧版本");
      return false;
    }

    if (res.status === 304) {
      return true; // ETag 命中，未变化，沿用旧的
    }
    if (res.status !== 200) {
      logger.warn(
        { status: res.status },
        "拉取 authz bundle 收到非预期状态码，沿用内存里已有的旧版本",
      );
      return false;
    }

    let body: BundleWireFormat;
    try {
      body = (await res.json()) as BundleWireFormat;
    } catch (err) {
      logger.error({ err }, "解析 authz bundle 失败，沿用内存里已有的旧版本");
      return false;
    }

    this.roles = body.roles ?? {};
    this.staleSince = body.stale_since ?? {};
    this.etag = res.headers.get("etag") ?? "";
    this.everFetched = true;
    return true;
  }
}

/**
 * 立刻拉一次，之后每 15 秒条件 GET 一次；首次成功之前按 0.5 秒起翻倍、
 * 封顶 15 秒退避重试。返回时那次"立刻拉一次"通常
 * 还没完成——同 be-sdk-python 的 `start_bundle_poller` 用
 * `asyncio.create_task` 一个道理，调用方要判定"是否已经连上过"该轮询
 * `hasEverFetched()`，不能假设返回时已经就绪。
 *
 * 不需要显式 Stop：进程退出（收到 SIGTERM/SIGINT）时 `runStandalone`
 * 直接 `process.exit`，这个 `setTimeout` 链条随进程一起结束，不需要
 * 单独取消（同 Python 版靠进程生命周期的判据；Go 版靠 ctx 取消是因为
 * goroutine 不会随对象被 GC 自动停止，JS 的 setTimeout 链条本来就是
 * "进程还活着才会继续排下一次"）。
 */
export function startBundlePoller(url: string, logger: Logger): BundleCache {
  const cache = new BundleCache();

  // ⚠️ 首次成功之前不等满 15 秒：组件常和 authz 同时启动，第一次拉取时
  // authz 多半还没起来。旧实现要等一个完整轮询周期才重试，这期间每个受
  // 保护的字段都答 503（"还不知道"），启动后大约 20 秒不可用。现在首次
  // 成功之前按 0.5 秒起翻倍退避（封顶轮询间隔）重试，成功之后才进入 15
  // 秒的条件轮询；成功过之后的单次失败照旧 fail-static，等下一个 15 秒。
  let succeeded = false;
  let retryDelay = BUNDLE_FIRST_RETRY_DELAY_MS;
  const tick = (): void => {
    void cache
      .tryFetchOnce(url, logger)
      .then(
        (ok) => {
          if (ok) succeeded = true;
        },
        () => {},
      )
      .finally(() => {
        if (succeeded) {
          setTimeout(tick, BUNDLE_POLL_INTERVAL_MS);
          return;
        }
        setTimeout(tick, retryDelay);
        retryDelay = nextBundleRetryDelay(retryDelay);
      });
  };
  tick();

  return cache;
}
