/** A&D standard ASCII: ST,+00012.40 kg or ST,GS,+00012.40kg; CRLF framing. */
export function parseScaleFrame(
  frame: string,
): Readonly<{ grams: number; basis: "weight" | "gross" | "net" }> | null {
  if (frame.length > 64) return null;
  const match = /^ST,(?:(GS|NT),)?\+([0-9]{1,8})(?:\.([0-9]{1,3}))?[ ]{0,2}(kg|g)\r\n$/u.exec(
    frame,
  );
  if (!match) return null;
  const fraction = match[3] ?? "";
  // Parse decimal digits as integers; reject sub-gram precision rather than rounding.
  if (match[4] === "g" && /[1-9]/u.test(fraction)) return null;
  const grams =
    Number(match[2]) * (match[4] === "kg" ? 1000 : 1) +
    (match[4] === "kg" ? Number(fraction.padEnd(3, "0")) : 0);
  if (!Number.isSafeInteger(grams) || grams < 1 || grams > 1000000) return null;
  return Object.freeze({
    grams,
    basis: match[1] === "GS" ? "gross" : match[1] === "NT" ? "net" : "weight",
  });
}

/** Reject an unstable/overload/invalid final frame. Never reuse an older stable value. */
export function parseScaleCapture(capture: string) {
  if (capture.length > 4096 || /[^\x20-\x7e\r\n]/u.test(capture)) return null;
  const frames = capture.split("\r\n");
  if (frames.at(-1) !== "") return null;
  return parseScaleFrame(`${frames.at(-2) ?? ""}\r\n`);
}
