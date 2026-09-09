/**
 * `runStandalone` 的子进程 fixture——同 be-sdk-go
 * `TestRunStandalone_healthz真的能响应不panic` 的判据：真走一遍
 * bootstrap → newLogger/newRegistry/getTracer → newGraphQLServer →
 * 真实 HTTP 监听，不是在测试进程里直接调函数。这个文件本身不是一条
 * vitest 用例，是被 `test/standalone.test.ts` 用 `tsx` 拉起的子进程。
 */

import { buildSchema } from "graphql";
import { runStandalone } from "../../src/standalone.js";
import { newGraphQLServer } from "../../src/graphqlServer.js";
import type { Module } from "../../src/module.js";

const schema = buildSchema("type Query { ping: String }");

runStandalone(async (rt) => {
  const httpHandler = newGraphQLServer(rt, {
    schema,
    context: () => ({}),
    getPersistedOperation: () => null,
  });
  return { httpHandler } satisfies Module;
});
