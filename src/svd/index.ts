import * as fs from "fs";
import { parseSvd, decodeValue, SvdDevice, SvdPeripheral, SvdRegister, DecodedField } from "./parser";

export { decodeValue };
export type { SvdDevice, SvdPeripheral, SvdRegister, DecodedField };

/**
 * Lazily-loaded SVD for the connected target.
 *
 * Parsing costs about 100 ms and a few megabytes of transient strings, so it
 * happens on first use rather than at startup — a session that never asks
 * about peripherals should not pay for one.
 *
 * Deliberately holds no probe reference. This class answers "what does this
 * address mean"; reading it is somebody else's job. Keeping those apart means
 * the decode logic is testable without hardware, which is the only reason the
 * address arithmetic could be verified against the DK before any of it shipped.
 */
export class SvdRegistry {
  private device: SvdDevice | null = null;
  private loadError: string | null = null;
  private readonly path: string | undefined;

  constructor(svdPath?: string) {
    this.path = svdPath;
  }

  get configured(): boolean {
    return !!this.path;
  }

  /** Human-readable reason the registry cannot answer, or null if it can. */
  unavailableReason(): string | null {
    if (!this.path) {
      return "No SVD file configured. Set jlinkMcp.svdPath (VSCode) or SVD_PATH " +
        "to a CMSIS-SVD file for your target. Vendors ship these; they are also " +
        "in CMSIS device family packs and the cmsis-svd collection.";
    }
    this.load();
    return this.loadError;
  }

  private load(): void {
    if (this.device || this.loadError) return;
    if (!this.path) { this.loadError = "no SVD path configured"; return; }
    if (!fs.existsSync(this.path)) {
      this.loadError = `SVD file not found: ${this.path}`;
      return;
    }
    try {
      this.device = parseSvd(this.path);
      if (this.device.peripherals.length === 0) {
        this.loadError = `Parsed ${this.path} but found no peripherals — is it a CMSIS-SVD file?`;
        this.device = null;
      }
    } catch (e: any) {
      this.loadError = `Could not parse ${this.path}: ${e?.message ?? e}`;
    }
  }

  getDevice(): SvdDevice | null {
    this.load();
    return this.device;
  }

  /** Peripherals, optionally filtered by a case-insensitive substring. */
  listPeripherals(filter?: string): SvdPeripheral[] {
    const d = this.getDevice();
    if (!d) return [];
    const f = filter?.toLowerCase();
    return d.peripherals
      .filter((p) => !f || p.name.toLowerCase().includes(f) || (p.groupName ?? "").toLowerCase().includes(f))
      .sort((a, b) => a.baseAddress - b.baseAddress);
  }

  findPeripheral(name: string): SvdPeripheral | undefined {
    const d = this.getDevice();
    if (!d) return undefined;
    const n = name.toLowerCase();
    return d.peripherals.find((p) => p.name.toLowerCase() === n);
  }

  /**
   * Resolve a register by peripheral and name.
   *
   * Clustered registers carry a dotted path (`INFO.PART`), and callers should
   * not have to know whether a given register happens to sit in a cluster —
   * so a bare `PART` matches `INFO.PART` when it is unambiguous.
   */
  findRegister(peripheral: string, register: string): SvdRegister | undefined {
    const p = this.findPeripheral(peripheral);
    if (!p) return undefined;
    const want = register.toLowerCase();
    const exact = p.registers.find((r) => r.name.toLowerCase() === want);
    if (exact) return exact;
    const tail = p.registers.filter((r) => r.name.toLowerCase().split(".").pop() === want);
    return tail.length === 1 ? tail[0] : undefined;
  }

  /** Suggest register names when a lookup misses — a miss is usually a typo. */
  suggestRegisters(peripheral: string, register: string, limit = 8): string[] {
    const p = this.findPeripheral(peripheral);
    if (!p) return [];
    const want = register.toLowerCase();
    return p.registers
      .map((r) => r.name)
      .filter((n) => n.toLowerCase().includes(want) || want.includes(n.toLowerCase().split(".").pop() ?? ""))
      .slice(0, limit);
  }
}

/** Render decoded fields compactly, one per line. */
export function formatDecoded(reg: SvdRegister, value: number, fields: DecodedField[]): string {
  const head = `${reg.name} @ 0x${reg.address.toString(16).toUpperCase().padStart(8, "0")} = ` +
    `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}` +
    (reg.access ? `  (${reg.access})` : "");
  if (fields.length === 0) {
    return `${head}\n  (no field definitions in the SVD for this register)`;
  }
  const lines = fields
    // Most significant first, which is how a reference manual lays them out.
    .slice()
    .sort((a, b) => parseInt(b.bits.replace(/[^\d:]/g, "").split(":")[0]) - parseInt(a.bits.replace(/[^\d:]/g, "").split(":")[0]))
    .map((f) => {
      const val = `0x${f.value.toString(16).toUpperCase()}`;
      const meaning = f.meaning ? ` → ${f.meaning}` : "";
      return `  ${f.bits.padEnd(9)} ${f.name.padEnd(16)} ${val}${meaning}`;
    });
  return [head, ...lines].join("\n");
}
