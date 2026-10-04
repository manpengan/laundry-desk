import assert from "node:assert/strict";

function assertCacheProtection(CachePolicy) {
  const request = { url: "https://cache.invalid/resource", headers: { host: "cache.invalid" } };
  const restricted = [
    { "set-cookie": "session=synthetic-test", "cache-control": "max-age=60" },
    { "cache-control": "public, max-age=60, proxy-revalidate" },
    { "cache-control": "public, max-age=60, no-cache" },
    { "cache-control": "public, max-age=60, no-store" },
    { "cache-control": "private, max-age=60" },
  ];
  for (const headers of restricted) {
    const policy = new CachePolicy(request, {
      status: 200,
      headers: {
        ...headers,
        "cache-control": `${headers["cache-control"]}, stale-while-revalidate=600`,
      },
    });
    for (const cached of [policy, CachePolicy.fromObject(policy.toObject())]) {
      for (const directive of ["max-stale", "max-stale=3600"]) {
        const incoming = {
          ...request,
          headers: { ...request.headers, "cache-control": directive },
        };
        assert.equal(cached.satisfiesWithoutRevalidation(incoming), false);
        const result = cached.evaluateRequest(incoming);
        assert.equal(result.response, undefined);
        assert.equal(result.revalidation.synchronous, true);
      }
    }
  }
  for (const [headers, options] of [
    [{ "cache-control": "public, max-age=1", age: "60" }, {}],
    [{ "cache-control": "max-age=0" }, {}],
    [{ "cache-control": "public, max-age=1", "set-cookie": "test=1", age: "60" }, {}],
    [{ "cache-control": "immutable, max-age=1", "set-cookie": "test=1", age: "60" }, {}],
    [{ "cache-control": "max-age=1", "set-cookie": "test=1", age: "60" }, { shared: false }],
  ]) {
    const policy = new CachePolicy(request, { status: 200, headers }, options);
    assert.equal(
      policy.satisfiesWithoutRevalidation({
        ...request,
        headers: { ...request.headers, "cache-control": "max-stale=3600" },
      }),
      true,
    );
  }
}

function depthError(error) {
  return (
    error instanceof SyntaxError &&
    error.message === "Brace nesting exceeds the maximum depth of 128"
  );
}

function nestedAst(depth) {
  let ast = { type: "brace", open: true, close: true, commas: 1, nodes: [] };
  for (let index = 0; index < depth; index++) {
    ast = { type: "brace", open: true, close: true, commas: 1, nodes: [ast] };
  }
  return { type: "root", nodes: [ast] };
}

function assertBracesProtection(braces) {
  for (const pattern of [
    "{".repeat(1000) + "a,b" + "}".repeat(1000),
    "(".repeat(1000) + "a" + ")".repeat(1000),
    "{(".repeat(500) + "a,b" + ")}".repeat(500),
    "{".repeat(1000) + "a,b",
  ]) {
    for (const operation of [
      braces,
      braces.parse,
      braces.compile,
      braces.expand,
      braces.stringify,
    ]) {
      assert.throws(() => operation(pattern, { maxDepth: Infinity }), depthError);
    }
  }
  for (const operation of [braces.compile, braces.expand, braces.stringify]) {
    assert.throws(() => operation(nestedAst(1000)), depthError);
    const cycle = { type: "root", nodes: [] };
    cycle.nodes.push(cycle);
    assert.throws(() => operation(cycle), depthError);
  }
  assert.deepEqual(braces.expand("src/{one,two}/{a,b}.ts"), [
    "src/one/a.ts",
    "src/one/b.ts",
    "src/two/a.ts",
    "src/two/b.ts",
  ]);
  assert.deepEqual(braces.expand("file-{1..3}.txt"), ["file-1.txt", "file-2.txt", "file-3.txt"]);
  assert.equal(braces.compile("src/{one,two}.ts"), "src/(one|two).ts");
  assert.equal(
    braces.stringify("{".repeat(100) + "x" + "}".repeat(100)),
    "{".repeat(100) + "x" + "}".repeat(100),
  );
  assert.deepEqual(braces.expand("\\{a,b\\}"), ["{a,b}"]);
}

export function assertPatchedDependencyBehavior(moduleName, implementation) {
  if (moduleName === "http-cache-semantics") return assertCacheProtection(implementation);
  if (moduleName === "braces") return assertBracesProtection(implementation);
  throw new Error("DEPENDENCY_PATCH_PROBE_UNKNOWN");
}
