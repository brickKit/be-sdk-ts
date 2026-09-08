/**
 * Config——对应 be-sdk-go 的 runtime.go、be-sdk-python 的 runtime.py。
 *
 * 模块读配置的唯一入口（设计书 §12.5.3）。模块代码里零 `process.env`。
 */

/**
 * 把 configSchema 属性名（camelCase，如 `pgSchema`）转成平台注入环境
 * 变量时真正用的名字（SCREAMING_SNAKE_CASE，如 `PG_SCHEMA`）。
 *
 * ⚠️ 这是移植自 be-sdk-go 的一个真实存在过的 bug 的修复：Go 版 `Config`
 * 的全部 getter 曾经直接拿调用方传的 camelCase 字符串去查，而查询用的
 * map 的 key 是平台装配阶段转换后的真实进程环境变量名，两边从来没对上
 * 过。四个已发布组件因默认值恰好等于真实值而未暴露五个版本——**本仓库
 * 从第一个提交起就实现对，不重犯**（阶段三计划 Task 1/2 明确要求）。
 *
 * 转换算法与 Go/Python 版逐字对应，且对已经是 SCREAMING_SNAKE_CASE 的
 * 输入是幂等的。
 */
export function configEnvVarName(key: string): string {
  let out = "";
  for (let i = 0; i < key.length; i++) {
    const ch = key[i]!;
    if (ch === "-" || ch === "." || ch === " ") {
      out += "_";
    } else if (ch >= "A" && ch <= "Z") {
      const prev = i > 0 ? key[i - 1]! : "";
      if (i > 0 && (/[a-z0-9]/.test(prev))) {
        out += "_";
      }
      out += ch;
    } else {
      out += ch.toUpperCase();
    }
  }
  return out;
}

export class Config {
  private readonly values: Readonly<Record<string, string>>;

  constructor(values: Record<string, string>) {
    this.values = { ...values };
  }

  string(key: string): { value: string; ok: boolean } {
    const v = this.values[configEnvVarName(key)];
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
}
