# be-sdk-ts: the official TypeScript runtime of be-protocol 1.0.
#
#   make sync-protocol     copy schemas/, ddl/, proto/ and vectors/ of be-protocol at $(PROTOCOL_TAG), and the
#                          decision vectors + bundle schema of contract-infra-authz at $(AUTHZ_TAG), into
#                          protocol/ (COMMITTED: the runtime ships protocol/schemas and protocol/ddl, the tests
#                          read protocol/vectors); then checks every SHA256SUMS
#   make test              typecheck + unit tests (offline: vectors, pure logic, in-process servers)
#   make test-integration  throwaway PostgreSQL 16 / 14 and NATS 2.12 containers (prefix sdkb-ts-), the
#                          integration tests, then removes the containers
#   make gen-test-proto    regenerate test/gen from test/proto with ts-proto (the options every TS component uses);
#                          google/rpc is a subset of googleapis, the interop oracle of src/grpc/statusDetails.ts
.PHONY: sync-protocol verify-protocol test typecheck build test-integration gen-test-proto import-scan

PROTOCOL_TAG  ?= v1.0.0-rc.1
AUTHZ_TAG     ?= v2.0.0-rc.1
# a local clone is used when present (the assembly repository checks both out as submodules),
# otherwise the GitHub repository
PROTOCOL_REPO ?= $(firstword $(wildcard ../be-protocol) https://github.com/brickKit/be-protocol)
AUTHZ_REPO    ?= $(firstword $(wildcard ../../contracts/infra/authz) https://github.com/brickKit/contract-infra-authz)
TMP           := $(shell mktemp -d -u)

sync-protocol:
	rm -rf protocol $(TMP) && mkdir -p protocol/authz $(TMP)
	git clone -q --depth 1 --branch $(PROTOCOL_TAG) $(PROTOCOL_REPO) $(TMP)/p
	git clone -q --depth 1 --branch $(AUTHZ_TAG) $(AUTHZ_REPO) $(TMP)/a
	cp -r $(TMP)/p/schemas $(TMP)/p/ddl $(TMP)/p/proto protocol/
	cd $(TMP)/p && find vectors -name '*.json' -not -path '*/gen/*' | xargs cp --parents -t $(CURDIR)/protocol
	cp $(TMP)/p/vectors/SHA256SUMS protocol/vectors/
	cp -r $(TMP)/a/vectors/decision protocol/authz/
	cp $(TMP)/a/vectors/SHA256SUMS $(TMP)/a/schemas/bundle.schema.json protocol/authz/
	printf 'be-protocol %s %s\ncontract-infra-authz %s %s\n' \
	  $(PROTOCOL_TAG) $$(git -C $(TMP)/p rev-parse HEAD) $(AUTHZ_TAG) $$(git -C $(TMP)/a rev-parse HEAD) > protocol/PINNED
	rm -rf $(TMP)
	$(MAKE) verify-protocol

verify-protocol:
	cd protocol/vectors && sha256sum -c --quiet SHA256SUMS
	cd protocol/authz && grep ' decision/' SHA256SUMS | sha256sum -c --quiet
	@echo "protocol/ matches $$(cat protocol/PINNED | tr '\n' ' ')"

typecheck:
	npx tsc --noEmit -p tsconfig.test.json

build:
	npx tsc -p tsconfig.json

test: typecheck verify-protocol
	npx vitest run --project unit

PG16 := sdkb-ts-pg16
PG14 := sdkb-ts-pg14
NATS := sdkb-ts-nats
test-integration:
	docker rm -f $(PG16) $(PG14) $(NATS) >/dev/null 2>&1 || true
	docker run -d --name $(PG16) -e POSTGRES_PASSWORD=admin -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
	docker run -d --name $(PG14) -e POSTGRES_PASSWORD=admin -p 127.0.0.1::5432 postgres:14-alpine >/dev/null
	docker run -d --name $(NATS) -p 127.0.0.1::4222 nats:2.12-alpine -js >/dev/null
	@for c in $(PG16) $(PG14); do until docker exec $$c pg_isready -U postgres -q; do sleep 0.5; done; done; sleep 1
	BE_TEST_PG16=postgres://postgres:admin@127.0.0.1:$$(docker port $(PG16) 5432 | head -1 | cut -d: -f2)/postgres \
	BE_TEST_PG14=postgres://postgres:admin@127.0.0.1:$$(docker port $(PG14) 5432 | head -1 | cut -d: -f2)/postgres \
	BE_TEST_NATS=nats://127.0.0.1:$$(docker port $(NATS) 4222 | head -1 | cut -d: -f2) \
	npx vitest run --project integration; rc=$$?; \
	docker rm -f $(PG16) $(PG14) $(NATS) >/dev/null; exit $$rc

gen-test-proto:
	rm -rf test/gen && mkdir -p test/gen
	node_modules/grpc-tools/bin/protoc --plugin=protoc-gen-ts_proto=node_modules/.bin/protoc-gen-ts_proto \
	  --ts_proto_out=test/gen \
	  --ts_proto_opt=outputServices=grpc-js,esModuleInterop=true,outputSchema=true,importSuffix=.js,enumsAsLiterals=true \
	  -Itest/proto -Iprotocol/proto test/proto/sdktest/v1/echo.proto test/proto/google/rpc/status.proto test/proto/google/rpc/error_details.proto

# be-sdk-ts depends on no component repository
import-scan:
	@bad=$$(grep -rlE "from [\"'](\.\./)*(mdm|erp|crm|infra|integration|hrm|prj|ana)[-_./]" src/ 2>/dev/null || true); \
	if [ -n "$$bad" ]; then echo "be-sdk-ts must not import a component: $$bad"; exit 1; fi; echo "no component imports"
