/**
 * C4 AI Tool Registry public surface (read-only projection).
 */

export {
  projectCatalogToTools,
  projectDefinitionToTool,
  projectInputJsonSchema,
  stripRedactedExampleArgs,
} from "./registry.js";
export type {
  JsonSchemaProjection,
  LlmToolDescriptor,
  LlmToolLimits,
  ToolExample,
} from "./registry.js";

export { AI_PRESET_WHITELISTS, listToolNames, listTools } from "./list-tools.js";
export type { ListToolsFilter } from "./list-tools.js";
