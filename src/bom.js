/**
 * Byte-level BOM detection. No decoding: a wrong decoder would hide the mark.
 *
 * "present" means the file begins with a BOM and the rest of it is valid in
 * that encoding. A file that merely starts with EF BB BF but is not UTF-8 is
 * reported as "corrupt", never as a clean BOM.
 */

export const MARKS = [
  { name: "utf-8", bytes: [0xef, 0xbb, 0xbf] },
  { name: "utf-32le", bytes: [0xff, 0xfe, 0x00, 0x00] },
  { name: "utf-32be", bytes: [0x00, 0x00, 0xfe, 0xff] },
  { name: "utf-16le", bytes: [0xff, 0xfe] },
  { name: "utf-16be", bytes: [0xfe, 0xff] },
];

export function detectBom(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  for (const mark of MARKS) {
    if (bytes.length < mark.bytes.length) continue;
    if (mark.bytes.every((b, i) => bytes[i] === b)) {
      return { encoding: mark.name, length: mark.bytes.length };
    }
  }
  return null;
}

export function stripBom(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const bom = detectBom(bytes);
  if (!bom) return { bom: null, body: bytes };
  return { bom, body: bytes.subarray(bom.length) };
}

/** True when every byte is a valid UTF-8 sequence. */
export function isValidUtf8(bytes) {
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let need = 0;
    if (b <= 0x7f) {
      i += 1;
      continue;
    } else if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) need = 2;
    else if (b >= 0xf0 && b <= 0xf4) need = 3;
    else return false;

    if (i + need >= bytes.length) return false;
    for (let k = 1; k <= need; k += 1) {
      if ((bytes[i + k] & 0xc0) !== 0x80) return false;
    }
    const cp = codePoint(bytes, i, need);
    if (need === 2 && cp < 0x800) return false;
    if (need === 3 && cp < 0x10000) return false;
    if (cp > 0x10ffff) return false;
    if (cp >= 0xd800 && cp <= 0xdfff) return false;
    i += need + 1;
  }
  return true;
}

function codePoint(bytes, i, need) {
  const masks = [0, 0x1f, 0x0f, 0x07];
  let cp = bytes[i] & masks[need];
  for (let k = 1; k <= need; k += 1) cp = (cp << 6) | (bytes[i + k] & 0x3f);
  return cp;
}

/**
 * UTF-16 code units, decoded without a BOM. Surrogate pairs are joined;
 * a lone surrogate makes the whole buffer invalid.
 */
export function decodeUtf16(bytes, littleEndian) {
  if (bytes.length % 2 !== 0) return null;
  const units = [];
  for (let i = 0; i < bytes.length; i += 2) {
    units.push(littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
  }
  let out = "";
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (u >= 0xd800 && u <= 0xdbff) {
      const next = units[i + 1];
      if (next === undefined || next < 0xdc00 || next > 0xdfff) return null;
      out += String.fromCodePoint(0x10000 + ((u - 0xd800) << 10) + (next - 0xdc00));
      i += 1;
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      return null;
    } else {
      out += String.fromCharCode(u);
    }
  }
  return out;
}

export function decodeUtf32(bytes, littleEndian) {
  if (bytes.length % 4 !== 0) return null;
  let out = "";
  for (let i = 0; i < bytes.length; i += 4) {
    const cp = littleEndian
      ? bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)
      : (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out += String.fromCodePoint(cp >>> 0);
  }
  return out;
}

/**
 * What the file actually is, independent of any policy.
 * @returns {{kind: "utf-8"|"bom"|"binary"|"corrupt", encoding?: string, bomLength?: number, text?: string, body?: Uint8Array}}
 */
export function inspectBytes(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const bom = detectBom(bytes);
  if (!bom) {
    if (isValidUtf8(bytes)) return { kind: "utf-8", text: new TextDecoder("utf-8").decode(bytes), body: bytes };
    return { kind: "binary" };
  }

  const body = bytes.subarray(bom.length);
  let text = null;
  if (bom.encoding === "utf-8") {
    if (!isValidUtf8(body)) return { kind: "corrupt", encoding: bom.encoding, bomLength: bom.length };
    text = new TextDecoder("utf-8").decode(body);
  } else if (bom.encoding === "utf-16le" || bom.encoding === "utf-16be") {
    text = decodeUtf16(body, bom.encoding === "utf-16le");
  } else {
    text = decodeUtf32(body, bom.encoding === "utf-32le");
  }
  if (text === null) return { kind: "corrupt", encoding: bom.encoding, bomLength: bom.length };
  return { kind: "bom", encoding: bom.encoding, bomLength: bom.length, text, body };
}
