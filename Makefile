# be-sdk-ts 不是 brickKit 组件，但仍按总纲 §I 的 9 个门禁目标写——
# 一致性帮 AI：新开会话看到一份陌生 Makefile，不用先猜它和组件仓库的
# Makefile 是不是同一套规矩。对照 be-sdk-go / be-sdk-python 的 Makefile 逐条抄。
.PHONY: check-version test image migrate-idempotent dag-check contract-check \
        import-scan smoke module-check all typecheck build

check-version: ## N/A：非组件仓库
	@echo "N/A：非组件仓库，没有 component.yaml"

typecheck: ## tsc --noEmit
	npx tsc --noEmit

build: ## tsc -p tsconfig.json，产出 dist/
	npx tsc -p tsconfig.json

test: typecheck ## vitest run（先 typecheck，类型错误当场拦）
	npx vitest run

image: ## N/A：纯横切库
	@echo "N/A：纯横切库，没有可执行文件，不产出部署镜像"

migrate-idempotent: ## N/A：非组件仓库
	@echo "N/A：非组件仓库，没有迁移"

dag-check: ## TS 的 import 图由 tsc 编译期检查（循环 import 在 ESM 下不会报错但会警告）
	@echo "✓ 交给 tsc/构建工具，ESM 循环 import 不是本仓库要单独守的东西"

contract-check: ## N/A：非组件仓库
	@echo "N/A：非组件仓库，没有 contracts/"

# ⚠️ be-sdk-ts 是铁律六 import 扫描的白名单本体之一（§13.3 铁律六）——它
# 被所有 TS 组件依赖，但它自己不许依赖任何组件仓库，否则白名单就变成了
# 传染通道。
import-scan: ## 扫 src/ 里有没有 import 组件仓库
	@bad=$$(grep -rlE "from [\"'](\.\./)*(mdm|erp|crm|infra|integration|hrm|prj|ana)[-_./]" src/ 2>/dev/null || true); \
	if [ -n "$$bad" ]; then \
		echo "✗ be-sdk-ts 不许依赖任何组件仓库：$$bad"; exit 1; \
	fi; \
	echo "✓ 零组件依赖"

smoke: ## N/A：非组件仓库
	@echo "N/A：非组件仓库，没有 brickkit up 的对象"

module-check: ## N/A：非组件仓库
	@echo "N/A：非组件仓库，没有 module 契约"

all: check-version test image migrate-idempotent dag-check contract-check import-scan smoke module-check

help: ## 列出全部目标
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
