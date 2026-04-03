import { ProbeBackend, ProbeType } from "./backend";
import { JLinkBackend, JLinkConfig } from "./jlink";
import { OpenOCDBackend, OpenOCDConfig } from "./openocd";
import { BlackMagicBackend, BlackMagicConfig } from "./blackmagic";
import { ProcessManager } from "../utils/process-manager";
import { log } from "../utils/logger";

export interface ProbeFactoryConfig {
  type: ProbeType;
  jlink?: Partial<JLinkConfig>;
  openocd?: Partial<OpenOCDConfig>;
  blackmagic?: Partial<BlackMagicConfig>;
}

export function createProbeBackend(
  config: ProbeFactoryConfig,
  processManager: ProcessManager
): ProbeBackend {
  log(`Creating probe backend: ${config.type}`);

  switch (config.type) {
    case "jlink":
      return new JLinkBackend(config.jlink || {}, processManager);

    case "openocd":
      return new OpenOCDBackend(config.openocd || {}, processManager);

    case "blackmagic":
      return new BlackMagicBackend(config.blackmagic || {}, processManager);

    case "probe-rs":
      throw new Error("probe-rs backend not yet implemented. Contributions welcome!");

    default:
      throw new Error(`Unknown probe type: ${config.type}. Supported: jlink, openocd, blackmagic`);
  }
}

export { ProbeBackend, ProbeType, ProbeState, ProbeErrorCode, ProbeStatus, CommandResult, GDBServerInfo, MemoryDumpLine } from "./backend";
export { JLinkBackend, JLinkConfig } from "./jlink";
export { OpenOCDBackend, OpenOCDConfig } from "./openocd";
export { BlackMagicBackend, BlackMagicConfig } from "./blackmagic";
