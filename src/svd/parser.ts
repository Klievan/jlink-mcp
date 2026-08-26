import * as fs from "fs";
import * as zlib from "zlib";
import * as sax from "sax";

/**
 * CMSIS-SVD parser.
 *
 * SVD is the format every Cortex-M vendor publishes to describe a part's
 * peripherals: base addresses, register offsets, bit fields, and — the part
 * that matters here — the enumerated meaning of those fields. Decoding
 * `ENABLE = 4` to `Enabled` is the difference between an LLM reasoning about
 * a device and guessing about one.
 *
 * Four features of the format are load-bearing, and all four appear in the
 * nRF52840's own file:
 *
 *  - `derivedFrom`: 31 of its 73 peripherals inherit their entire register map
 *    from a sibling. Ignoring it silently loses 42% of the chip.
 *  - clusters: registers nest, so an address is base + cluster + register.
 *  - `dim` arrays: `DEVICEID[%s]` with dim=2 expands to two registers.
 *  - bit position has three encodings. Nordic uses `lsb`/`msb` for all 2427 of
 *    its fields; other vendors use `bitOffset`/`bitWidth` or `bitRange`. All
 *    three are handled, because assuming one was already wrong once.
 */

export interface SvdEnum {
  name: string;
  value: number;
  description?: string;
}

export interface SvdField {
  name: string;
  description?: string;
  /** Least significant bit position. */
  lsb: number;
  /** Bit count, >= 1. */
  width: number;
  enums: SvdEnum[];
}

export interface SvdRegister {
  name: string;
  description?: string;
  /** Absolute address: peripheral base + cluster offsets + register offset. */
  address: number;
  size: number;
  access?: string;
  resetValue?: number;
  fields: SvdField[];
}

export interface SvdPeripheral {
  name: string;
  description?: string;
  baseAddress: number;
  groupName?: string;
  registers: SvdRegister[];
}

export interface SvdDevice {
  name: string;
  vendor?: string;
  description?: string;
  peripherals: SvdPeripheral[];
}

/** Raw node captured during the streaming pass, before offsets are resolved. */
interface RawNode {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: RawNode[];
  parent?: RawNode;
}

const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const t = s.trim();
  if (/^0x/i.test(t)) return parseInt(t, 16);
  if (/^#/.test(t)) return parseInt(t.slice(1).replace(/x/gi, "0"), 2); // SVD binary literal
  if (/^0b/i.test(t)) return parseInt(t.slice(2), 2);
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

const child = (n: RawNode, tag: string): RawNode | undefined =>
  n.children.find((c) => c.tag === tag);
const childText = (n: RawNode, tag: string): string | undefined =>
  child(n, tag)?.text.trim() || undefined;
const childNum = (n: RawNode, tag: string): number | undefined =>
  num(childText(n, tag));

/**
 * Read an SVD from disk into a raw node tree.
 *
 * Accepts `.gz` transparently: these files are a couple of megabytes of XML
 * that compress to about a twentieth of that, and a compressed fixture is far
 * more pleasant to keep in a repository.
 */
export function loadSvdXml(filePath: string): RawNode {
  const raw = fs.readFileSync(filePath);
  const xml = (filePath.endsWith(".gz") ? zlib.gunzipSync(raw) : raw).toString("utf8");
  return parseXml(xml);
}

function parseXml(xml: string): RawNode {
  const root: RawNode = { tag: "#root", attrs: {}, text: "", children: [] };
  let current = root;
  // strict:false — vendor files are generally well-formed, but a strict parser
  // rejecting a whole 2 MB device over one stray entity helps nobody.
  const parser = sax.parser(false, { trim: false, normalize: false });

  parser.onopentag = (node: sax.Tag) => {
    const n: RawNode = {
      tag: node.name.toLowerCase(),
      attrs: Object.fromEntries(
        Object.entries(node.attributes as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
      ),
      text: "",
      children: [],
      parent: current,
    };
    current.children.push(n);
    current = n;
  };
  parser.ontext = (t: string) => { current.text += t; };
  parser.oncdata = (t: string) => { current.text += t; };
  parser.onclosetag = () => { current = current.parent ?? root; };
  parser.onerror = function (this: sax.SAXParser) { this.resume(); };

  parser.write(xml).close();
  return root;
}

/** Bit position, across all three encodings SVD permits. */
function bitPosition(f: RawNode): { lsb: number; width: number } {
  const bitOffset = childNum(f, "bitoffset");
  if (bitOffset !== undefined) {
    return { lsb: bitOffset, width: childNum(f, "bitwidth") ?? 1 };
  }
  const lsb = childNum(f, "lsb");
  const msb = childNum(f, "msb");
  if (lsb !== undefined && msb !== undefined) {
    return { lsb, width: msb - lsb + 1 };
  }
  // "[msb:lsb]"
  const range = childText(f, "bitrange");
  const m = range?.match(/\[\s*(\d+)\s*:\s*(\d+)\s*\]/);
  if (m) {
    const hi = Number(m[1]), lo = Number(m[2]);
    return { lsb: lo, width: hi - lo + 1 };
  }
  return { lsb: 0, width: 32 };
}

function parseFields(regNode: RawNode): SvdField[] {
  const container = child(regNode, "fields");
  if (!container) return [];
  return container.children
    .filter((f) => f.tag === "field")
    .map((f) => {
      const { lsb, width } = bitPosition(f);
      const enums: SvdEnum[] = [];
      const evContainer = child(f, "enumeratedvalues");
      if (evContainer) {
        for (const ev of evContainer.children.filter((c) => c.tag === "enumeratedvalue")) {
          const value = childNum(ev, "value");
          const name = childText(ev, "name");
          if (value !== undefined && name) {
            enums.push({ name, value, description: childText(ev, "description") });
          }
        }
      }
      return {
        name: childText(f, "name") ?? "?",
        description: childText(f, "description"),
        lsb,
        width,
        enums,
      };
    });
}

/**
 * Expand a `dim` array into its instances.
 *
 * `DEVICEID[%s]` with dim=2 and dimIncrement=4 becomes DEVICEID[0] and
 * DEVICEID[1] at consecutive addresses. Some vendors use `dimIndex` to supply
 * names other than 0..n-1.
 */
function expandDim(node: RawNode, baseName: string, baseOffset: number): Array<{ name: string; offset: number }> {
  const dim = childNum(node, "dim");
  if (!dim || dim < 1) return [{ name: baseName, offset: baseOffset }];
  const inc = childNum(node, "dimincrement") ?? 4;
  const indexSpec = childText(node, "dimindex");
  let indices: string[];
  if (indexSpec && indexSpec.includes(",")) indices = indexSpec.split(",").map((s) => s.trim());
  else if (indexSpec && indexSpec.includes("-")) {
    const [a, b] = indexSpec.split("-").map((s) => Number(s.trim()));
    indices = Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
  } else indices = Array.from({ length: dim }, (_, i) => String(i));

  return indices.slice(0, dim).map((idx, i) => ({
    name: baseName.includes("%s") ? baseName.replace("%s", idx) : `${baseName}${idx}`,
    offset: baseOffset + i * inc,
  }));
}

/** Walk registers and clusters, accumulating offsets. */
function collectRegisters(container: RawNode, base: number, prefix: string): SvdRegister[] {
  const out: SvdRegister[] = [];
  for (const node of container.children) {
    if (node.tag === "register") {
      const name = childText(node, "name") ?? "?";
      const offset = childNum(node, "addressoffset") ?? 0;
      for (const inst of expandDim(node, name, offset)) {
        out.push({
          name: prefix ? `${prefix}.${inst.name}` : inst.name,
          description: childText(node, "description"),
          address: base + inst.offset,
          size: childNum(node, "size") ?? 32,
          access: childText(node, "access"),
          resetValue: childNum(node, "resetvalue"),
          fields: parseFields(node),
        });
      }
    } else if (node.tag === "cluster") {
      const name = childText(node, "name") ?? "?";
      const offset = childNum(node, "addressoffset") ?? 0;
      for (const inst of expandDim(node, name, offset)) {
        const clusterPrefix = prefix ? `${prefix}.${inst.name}` : inst.name;
        out.push(...collectRegisters(node, base + inst.offset, clusterPrefix));
      }
    }
  }
  return out;
}

/** Parse an SVD file into a resolved device description. */
export function parseSvd(filePath: string): SvdDevice {
  const root = parseXmlRoot(loadSvdXml(filePath));
  const deviceNode = root;

  const periphContainer = findDescendant(deviceNode, "peripherals");
  const rawPeripherals = periphContainer
    ? periphContainer.children.filter((c) => c.tag === "peripheral")
    : [];

  // First pass: index by name so derivedFrom can resolve.
  const byName = new Map<string, RawNode>();
  for (const p of rawPeripherals) {
    const n = childText(p, "name");
    if (n) byName.set(n, p);
  }

  const peripherals: SvdPeripheral[] = [];
  for (const p of rawPeripherals) {
    const name = childText(p, "name") ?? "?";
    const base = childNum(p, "baseaddress") ?? 0;

    // derivedFrom: inherit the parent's register map, keeping our own base
    // address and name. Nordic uses this for 31 of 73 peripherals — every
    // TIMER, SPIM, UARTE instance beyond the first.
    const parentName = p.attrs["derivedfrom"];
    const source = parentName && byName.has(parentName) ? byName.get(parentName)! : p;

    const regsContainer = child(source, "registers");
    peripherals.push({
      name,
      description: childText(p, "description") ?? childText(source, "description"),
      baseAddress: base,
      groupName: childText(p, "groupname") ?? childText(source, "groupname"),
      registers: regsContainer ? collectRegisters(regsContainer, base, "") : [],
    });
  }

  return {
    name: childText(deviceNode, "name") ?? "unknown",
    vendor: childText(deviceNode, "vendor"),
    description: childText(deviceNode, "description"),
    peripherals,
  };
}

function parseXmlRoot(root: RawNode): RawNode {
  return root.children.find((c) => c.tag === "device") ?? root;
}

function findDescendant(n: RawNode, tag: string): RawNode | undefined {
  for (const c of n.children) {
    if (c.tag === tag) return c;
    const deeper = findDescendant(c, tag);
    if (deeper) return deeper;
  }
  return undefined;
}

// ── Decoding ──────────────────────────────────────────────────────

/** One decoded field of a register value. */
export interface DecodedField {
  name: string;
  value: number;
  /** The enumerated name, when the value matches one. */
  meaning?: string;
  bits: string;
  description?: string;
}

/**
 * Split a raw register value into its named fields.
 *
 * This is the whole point of the exercise: `0x00000004` means nothing, while
 * `ENABLE = 4 (Enabled)` is something to reason about.
 */
export function decodeValue(reg: SvdRegister, value: number): DecodedField[] {
  return reg.fields.map((f) => {
    const mask = f.width >= 32 ? 0xffffffff : ((1 << f.width) - 1) >>> 0;
    const v = (value >>> f.lsb) & mask;
    const hit = f.enums.find((e) => e.value === v);
    return {
      name: f.name,
      value: v,
      meaning: hit?.name,
      bits: f.width === 1 ? `[${f.lsb}]` : `[${f.lsb + f.width - 1}:${f.lsb}]`,
      description: hit?.description ?? f.description,
    };
  });
}
