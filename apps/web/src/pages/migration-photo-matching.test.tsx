import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { MigrationPort } from "../host/migration-port.js";
import { matchMigrationPhotos } from "./migration-photo-matching.js";
import { V1MigrationPhotos } from "./V1MigrationPhotos.js";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const target = (id: string, path: string) => ({
  id,
  source_relative_path: path,
  garment_id: `garment-${id}`,
});
function photo(name: string, relative = name): File {
  return {
    name,
    webkitRelativePath: relative,
    type: "image/jpeg",
    size: 3,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as File;
}
const unavailable = async () => ({ ok: false as const, error: "not used" });
function port(photo: MigrationPort["photo"]): MigrationPort {
  return { draft: unavailable, photo, review: unavailable, authorize: unavailable };
}
function click(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => node.children.join("") === label);
  assert.ok(button, label);
  (button.props.onClick as () => void)();
}
test("directory matches retain all 1000 old photo and garment identifiers without changing totals", () => {
  const targets = Array.from({ length: 1000 }, (_, i) => target(`p${i}`, `orders/${i}/photo.jpg`));
  const files = targets.map((item) => photo("photo.jpg", `selected/${item.source_relative_path}`));
  const result = matchMigrationPhotos(targets, files);
  assert.equal(result.matches.length, 1000);
  assert.equal(result.matches.filter((row) => row.state === "matched").length, 1000);
  assert.deepEqual(
    result.matches.map((row) => row.target),
    targets,
  );
  assert.deepEqual(
    result.matches.map((row) => row.selected),
    files.map((_item, i) => i),
  );
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.unmatched, []);
});
test("same-name ambiguity, missing paths and unsupported files are not silently matched", () => {
  const result = matchMigrationPhotos(
    [target("a", "one/a.jpg"), target("b", "two/a.jpg"), target("c", "gone.png")],
    [photo("a.jpg"), { ...photo("bad.exe"), type: "application/octet-stream" }, photo("extra.jpg")],
  );
  assert.deepEqual(
    result.matches.map((row) => row.state),
    ["ambiguous", "ambiguous", "missing"],
  );
  assert.ok(result.matches.every((row) => row.selected === null));
  assert.equal(result.rejected[0]?.index, 1);
  assert.deepEqual(result.unmatched, [2]);
  assert.equal(
    matchMigrationPhotos([target("a", "a.jpg")], [photo("a.jpg"), photo("a.jpg")]).matches[0]
      ?.state,
    "ambiguous",
  );
});
test("bulk upload previews matching, retries failed original identifier, and paginates large lists", async () => {
  const calls: string[] = [],
    uploaded: string[] = [];
  const photos = Array.from({ length: 30 }, (_, i) => target(`p${i}`, `${i}.jpg`));
  const client = port(async (draft, id) => {
    calls.push(`${draft}:${id}`);
    return calls.length === 1 ? { ok: false, error: "temporary" } : { ok: true, data: true };
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <V1MigrationPhotos
        draftId="draft"
        photos={photos}
        uploaded={uploaded}
        port={client}
        disabled={false}
        onUploaded={(id) => uploaded.push(id)}
        onBusyChange={() => {}}
      />,
    );
  });
  assert.equal(renderer.root.findAllByType("li").length, 25);
  const input = renderer.root.findAllByType("input").find((node) => node.props.multiple === true)!;
  await act(async () =>
    input.props.onChange({ currentTarget: { files: [photo("0.jpg")], value: "" } }),
  );
  assert.match(JSON.stringify(renderer.toJSON()), /0.jpg/u);
  await act(async () =>
    renderer.root
      .findByProps({ type: "checkbox" })
      .props.onChange({ currentTarget: { checked: true } }),
  );
  await act(async () => click(renderer, "上传已确认的 1 张照片"));
  assert.match(JSON.stringify(renderer.toJSON()), /temporary/u);
  await act(async () => click(renderer, "重试此照片"));
  assert.deepEqual(calls, ["draft:p0", "draft:p0"]);
  assert.deepEqual(uploaded, ["p0"]);
  await act(async () => renderer.unmount());
});
test("late photo response after draft switch never changes the next draft", async () => {
  let resolve!: (value: Awaited<ReturnType<MigrationPort["photo"]>>) => void;
  const client = port(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const completed: string[] = [];
  let renderer!: ReactTestRenderer;
  const element = (draftId: string) => (
    <V1MigrationPhotos
      draftId={draftId}
      photos={[target("p", "a.jpg")]}
      uploaded={[]}
      port={client}
      disabled={false}
      onUploaded={(id) => completed.push(id)}
      onBusyChange={() => {}}
    />
  );
  await act(async () => {
    renderer = create(element("old"));
  });
  await act(async () =>
    renderer.root
      .findAllByType("input")
      .find((node) => node.props.multiple === true)!
      .props.onChange({ currentTarget: { files: [photo("a.jpg")], value: "" } }),
  );
  await act(async () =>
    renderer.root
      .findByProps({ type: "checkbox" })
      .props.onChange({ currentTarget: { checked: true } }),
  );
  await act(async () => click(renderer, "上传已确认的 1 张照片"));
  await act(async () => renderer.update(element("new")));
  await act(async () => resolve({ ok: true, data: true }));
  assert.deepEqual(completed, []);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /本次已上传/u);
  await act(async () => renderer.unmount());
});
