const EXACT_SEMVER = /^(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})$/u;
const UNSAFE_ENTITY = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/u;

type XmlToken =
  | Readonly<{ kind: "start" | "end" | "empty"; name: string }>
  | Readonly<{ kind: "text"; value: string }>;

type PlistValue = string | boolean | PlistArray | PlistDictionary;
interface PlistArray extends ReadonlyArray<PlistValue> {}
interface PlistDictionary {
  readonly [key: string]: PlistValue;
}

export type PackagedMacAppIdentity = Readonly<{
  bundle_identifier: "com.laundry-desk.v2";
  bundle_name: "laundry-desk V2";
  bundle_executable: "laundry-desk V2";
  app_version: string;
}>;

export class InfoPlistError extends Error {}

function isPlistDictionary(value: PlistValue): value is PlistDictionary {
  return typeof value === "object" && !Array.isArray(value);
}

function decodeEntity(entity: string): string {
  if (entity === "amp") return "&";
  if (entity === "lt") return "<";
  if (entity === "gt") return ">";
  if (entity === "quot") return '"';
  if (entity === "apos") return "'";
  const radix = entity.startsWith("#x") ? 16 : 10;
  const digits = entity.slice(radix === 16 ? 2 : 1);
  const codePoint = Number.parseInt(digits, radix);
  if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    throw new InfoPlistError("packaged app Info.plist contains an invalid entity");
  }
  return String.fromCodePoint(codePoint);
}

function decodeXmlText(value: string): string {
  if (UNSAFE_ENTITY.test(value)) {
    throw new InfoPlistError("packaged app Info.plist contains an unsupported entity");
  }
  return value.replace(/&([^;]+);/gu, (_match, entity: string) => decodeEntity(entity));
}

function tokenizeInfoPlist(xml: string): readonly XmlToken[] {
  const tokens: XmlToken[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    if (xml[cursor] !== "<") {
      const end = xml.indexOf("<", cursor);
      const next = end === -1 ? xml.length : end;
      tokens.push(Object.freeze({ kind: "text", value: xml.slice(cursor, next) }));
      cursor = next;
      continue;
    }
    if (xml.startsWith("<?xml", cursor)) {
      const end = xml.indexOf("?>", cursor + 5);
      if (end === -1) throw new InfoPlistError("packaged app Info.plist XML is invalid");
      const declaration = xml.slice(cursor, end + 2);
      if (!/^<\?xml\s+version="1\.0"\s+encoding="UTF-8"\s*\?>$/u.test(declaration)) {
        throw new InfoPlistError("packaged app Info.plist XML declaration is invalid");
      }
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!--", cursor)) {
      const end = xml.indexOf("-->", cursor + 4);
      if (end === -1) throw new InfoPlistError("packaged app Info.plist XML is invalid");
      cursor = end + 3;
      continue;
    }
    const end = xml.indexOf(">", cursor + 1);
    if (end === -1) throw new InfoPlistError("packaged app Info.plist XML is invalid");
    const tag = xml.slice(cursor, end + 1);
    if (
      tag ===
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    ) {
      cursor = end + 1;
      continue;
    }
    if (tag === '<plist version="1.0">') {
      tokens.push(Object.freeze({ kind: "start", name: "plist" }));
    } else {
      const parsed =
        /^<(\/)?(plist|dict|array|key|string|integer|real|date|data|true|false)(\/?)>$/u.exec(tag);
      if (parsed === null || (parsed[1] === "/" && parsed[3] === "/")) {
        throw new InfoPlistError("packaged app Info.plist contains an unsupported XML tag");
      }
      tokens.push(
        Object.freeze({
          kind: parsed[1] === "/" ? "end" : parsed[3] === "/" ? "empty" : "start",
          name: parsed[2]!,
        }),
      );
    }
    cursor = end + 1;
  }
  return Object.freeze(tokens);
}

class PlistParser {
  private cursor = 0;

  constructor(private readonly tokens: readonly XmlToken[]) {}

  parse(): PlistDictionary {
    this.skipWhitespace();
    this.expect("start", "plist");
    const value = this.parseValue();
    this.expect("end", "plist");
    this.skipWhitespace();
    if (this.cursor !== this.tokens.length || !isPlistDictionary(value)) {
      throw new InfoPlistError("packaged app Info.plist root is invalid");
    }
    return value;
  }

  private skipWhitespace(): void {
    while (this.tokens[this.cursor]?.kind === "text") {
      const token = this.tokens[this.cursor]!;
      if (token.kind !== "text" || token.value.trim() !== "") break;
      this.cursor += 1;
    }
  }

  private expect(kind: "start" | "end" | "empty", name: string): void {
    this.skipWhitespace();
    const token = this.tokens[this.cursor];
    if (token?.kind !== kind || token.name !== name) {
      throw new InfoPlistError("packaged app Info.plist structure is invalid");
    }
    this.cursor += 1;
  }

  private parseText(name: string): string {
    this.expect("start", name);
    const token = this.tokens[this.cursor];
    const value = token?.kind === "text" ? token.value : "";
    if (token?.kind === "text") this.cursor += 1;
    this.expect("end", name);
    return decodeXmlText(value);
  }

  private parseValue(): PlistValue {
    this.skipWhitespace();
    const token = this.tokens[this.cursor];
    if (token?.kind === "empty" && (token.name === "true" || token.name === "false")) {
      this.cursor += 1;
      return token.name === "true";
    }
    if (token?.kind !== "start") {
      throw new InfoPlistError("packaged app Info.plist value is invalid");
    }
    if (["string", "integer", "real", "date", "data"].includes(token.name)) {
      return this.parseText(token.name);
    }
    if (token.name === "array") return this.parseArray();
    if (token.name === "dict") return this.parseDictionary();
    throw new InfoPlistError("packaged app Info.plist value type is unsupported");
  }

  private parseArray(): PlistArray {
    this.expect("start", "array");
    const values: PlistValue[] = [];
    while (true) {
      this.skipWhitespace();
      const token = this.tokens[this.cursor];
      if (token?.kind === "end" && token.name === "array") break;
      values.push(this.parseValue());
    }
    this.expect("end", "array");
    return Object.freeze(values);
  }

  private parseDictionary(): PlistDictionary {
    this.expect("start", "dict");
    let dictionary: PlistDictionary = Object.freeze({});
    while (true) {
      this.skipWhitespace();
      const token = this.tokens[this.cursor];
      if (token?.kind === "end" && token.name === "dict") break;
      const key = this.parseText("key");
      if (Object.hasOwn(dictionary, key)) {
        throw new InfoPlistError("packaged app Info.plist contains a duplicate key");
      }
      dictionary = Object.freeze({ ...dictionary, [key]: this.parseValue() });
    }
    this.expect("end", "dict");
    return dictionary;
  }
}

function requiredString(dictionary: PlistDictionary, key: string): string {
  const value = dictionary[key];
  if (typeof value !== "string") {
    throw new InfoPlistError("packaged app Info.plist identity is incomplete");
  }
  return value;
}

export function parsePackagedMacAppInfoPlist(bytes: Buffer): PackagedMacAppIdentity {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InfoPlistError("packaged app Info.plist must be UTF-8 XML");
  }
  const dictionary = new PlistParser(tokenizeInfoPlist(xml)).parse();
  const identifier = requiredString(dictionary, "CFBundleIdentifier");
  const packageType = requiredString(dictionary, "CFBundlePackageType");
  const name = requiredString(dictionary, "CFBundleName");
  const executable = requiredString(dictionary, "CFBundleExecutable");
  const shortVersion = requiredString(dictionary, "CFBundleShortVersionString");
  const bundleVersion = requiredString(dictionary, "CFBundleVersion");
  if (
    identifier !== "com.laundry-desk.v2" ||
    packageType !== "APPL" ||
    name !== "laundry-desk V2" ||
    executable !== "laundry-desk V2" ||
    shortVersion !== bundleVersion ||
    !EXACT_SEMVER.test(shortVersion)
  ) {
    throw new InfoPlistError("packaged app Info.plist identity is invalid");
  }
  return Object.freeze({
    bundle_identifier: "com.laundry-desk.v2",
    bundle_name: "laundry-desk V2",
    bundle_executable: "laundry-desk V2",
    app_version: shortVersion,
  });
}
