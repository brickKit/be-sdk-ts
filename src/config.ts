/**
 * Config——对应 be-sdk-go 的 runtime.go、be-sdk-python 的 runtime.py。
 *
 * 模块读配置的唯一入口（设计书 §12.5.3）。模块代码里零 `process.env`。
 */

import { envName } from "./endpoint.js";

export class Config {
  private readonly values: Readonly<Record<string, string>>;

  constructor(values: Record<string, string>) {
    this.values = { ...values };
  }

  /** 精确匹配键名（UPPER_SNAKE 环境变量名），不做任何大小写/驼峰转换。 */
  string(key: string): { value: string; ok: boolean } {
    const v = this.values[key];
    return v === undefined ? { value: "", ok: false } : { value: v, ok: true };
  }

  stringOr(key: string, defaultValue: string): string {
    const { value, ok } = this.string(key);
    return ok ? value : defaultValue;
  }

  /**
   * 用于 configSchema 里没写 default 的必填项：拿不到直接抛异常，因为
   * 这类配置缺失属于部署错误，不该让模块带着一个空字符串跑起来。
   */
  mustString(key: string): string {
    const { value, ok } = this.string(key);
    if (!ok) {
      throw new Error(`必填配置项 "${key}" 未注入`);
    }
    return value;
  }

  int(key: string): { value: number; ok: boolean } {
    const { value, ok } = this.string(key);
    if (!ok) return { value: 0, ok: false };
    const n = Number.parseInt(value, 10);
    return Number.isNaN(n) ? { value: 0, ok: false } : { value: n, ok: true };
  }

  intOr(key: string, defaultValue: number): number {
    const { value, ok } = this.int(key);
    return ok ? value : defaultValue;
  }

  bool(key: string): { value: boolean; ok: boolean } {
    const { value, ok } = this.string(key);
    if (!ok) return { value: false, ok: false };
    const lowered = value.trim().toLowerCase();
    if (["true", "1", "t", "yes"].includes(lowered)) return { value: true, ok: true };
    if (["false", "0", "f", "no"].includes(lowered)) return { value: false, ok: true };
    return { value: false, ok: false };
  }

  boolOr(key: string, defaultValue: boolean): boolean {
    const { value, ok } = this.bool(key);
    return ok ? value : defaultValue;
  }

  /**
   * 从 Config 读 `<ID>[_<PORT>]_ENDPOINT` 并剥掉 scheme 与结尾斜杠。
   *
   * ⚠️ 绝不回落到 process.env（合并态下一个进程只有一份 environ，设计书
   * §12.5.3）；键缺失与值为空都视为缺失。
   */
  endpoint(dep: string, extra = ""): { value: string; ok: boolean } {
    const { value, ok } = this.string(envName(dep, extra));
    if (!ok || value === "") return { value: "", ok: false };
    return { value: value.replace(/^https?:\/\//, "").replace(/\/$/, ""), ok: true };
  }

  /** 用于强依赖：缺失即抛异常（强依赖缺失时平台本来就会阻断启动）。 */
  mustEndpoint(dep: string, extra = ""): string {
    const { value, ok } = this.endpoint(dep, extra);
    if (!ok) throw new Error(`强依赖 ${dep} 的 ${envName(dep, extra)} 未注入`);
    return value;
  }

  /** 读 `S3_URL`（完整 URL，含 scheme，原样返回，不剥不加）。 */
  s3Url(): { value: string; ok: boolean } {
    const { value, ok } = this.string("S3_URL");
    return ok && value !== "" ? { value, ok: true } : { value: "", ok: false };
  }
}
