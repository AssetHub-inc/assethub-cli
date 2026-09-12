#!/usr/bin/env node
import {setTimeout as delay} from 'node:timers/promises'
import {cliVersion, diagnose, mcpConfig} from './setup.js'
import {ingestProjectSources} from './projectSources.js'
import {downloadCanvas} from './canvasDownload.js'
import {
  executeNodeMeshBatch,
  resumeNodeMeshBatch,
  type NodeMeshBatchResult,
} from './nodeMeshBatch.js'
import {writeCanvasComparison} from './canvasComparison.js'
import {importCanvasAssetWithState} from './canvasAssetImport.js'
import {execFile, spawn} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {realpathSync} from 'node:fs'
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import {homedir, tmpdir} from 'node:os'
import {basename, dirname, extname, join, resolve} from 'node:path'
import {argv, env, exit, stdin, stderr, stdout} from 'node:process'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {promisify} from 'node:util'
import {
  AssetHubApiError,
  WorkspaceClientError,
  createWorkspaceClient,
  type AnimationRetargetRequest,
  type BlobLocation,
  type MoodboardInput,
  type CanvasLayoutInput,
  type LanguageRequest,
  type VisionRequest,
  type FileMediaType,
  type Intervention,
  type Job,
  type RigRequest,
  type RigType,
  type Source,
  type CanvasExecution,
  type ImageGenerationRequest,
  type MeshGenerationRequest,
  type MeshComposeRequest,
  type MeshRefineRequest,
  type MeshRefinementCapabilities,
  type MeshRefinementMode,
  type MeshTransform,
  type ExecutionContext,
  type EvaluationReport,
  type ProductionAutomationRequest,
  type ProductionAutomationImage,
  createAssetHubClient,
} from '@assethub/api-client'

import {resolveCanvasSelection, saveCanvasSelection} from './canvas.js'
import {
  activeExecution,
  childOperationId,
  CliExecutionError,
  executeRecorded,
  hasRecordedOperation,
  openExecutionSession,
  resumeRecorded,
  waitForExecution,
} from './execution.js'

import {buildRunUploadPlan, formatBytes} from './runsUpload/buildRunUpload.js'
import {readGraphFolder} from './runsUpload/graphFolder.js'
import {uploadRun} from './runsUpload/uploadRun.js'

type Flags = Record<string, string | boolean | string[]>

type ParsedArgs = {
  positionals: string[]
  flags: Flags
}

type AuthProfile = {
  apiKey?: string
  authentication?: 'personal'
  accessToken?: string
  workspaceMfaToken?: string
  userId?: string
  workspaceId?: string
  baseUrl: string
  updatedAt: string
}

type AuthConfig = {
  defaultProfile?: string
  profiles?: Record<string, AuthProfile>
}

type ResolvedAuth = {
  apiKey: string
  authentication?: 'personal'
  workspaceId?: string
  baseUrl: string
  profile: string
  source: 'flag' | 'env' | 'profile'
}

type CommandContext = {
  client: ReturnType<typeof createAssetHubClient>
  flags: Flags
  auth: ResolvedAuth
  /**
   * The raw argument slice, kept alongside the parsed flags because `Flags` is
   * keyed by flag name and so cannot say which of two different flags came
   * first. `production intervene` needs that order: an intervention batch's seq
   * order in the log is the operator's own order of decisions.
   */
  args: string[]
}

type ProductionAnalyzeSourceInput = ProductionAutomationImage

type SourceDescriptor =
  | {
      kind: 'source'
      source: Source
    }
  | {
      kind: 'file'
      path: string
      contentType?: string
    }
  | {
      kind: 'blob'
      blob: Blob
      fileName: string
      contentType?: string
    }

const defaultBaseUrl = 'https://app.assethub.io'
// Mirrors PUBLIC_IMAGE_GENERATE_DEFAULT_MODEL_ID in apps/frontend
// (src/feature/imageGen/util/publicImageGenDefaultModel.ts). This package does
// not depend on the app, so the value is duplicated: keep the two in step so
// `assethub image generate` without --model matches the API's own default.
const defaultImageModelId = 'imageGen.nanoBanana2.openrouter'
const defaultMeshModelId = 'meshGen.hunyuan31'
const defaultProfileName = 'default'
const defaultPartExtractorName = 'V1.5'
const artifactGraphPartExtractorApiValues = new Set([
  'ah_agent_graph_v3_6_1',
  'ah_agent_graph_v3_6_3',
  'ah_agent_graph_v3_6_4',
  'ah_agent_graph_v3_6_5',
  'ah_agent_graph_pluffy_v3_1',
])

type PartExtractorOption = {
  publicName: string
  apiValue: string
  aliases: readonly string[]
}

const partExtractorOptions = [
  {
    publicName: 'V1.5',
    apiValue: 'ah_part_extractor_v65',
    aliases: ['v1.5', '1.5', 'latest', 'default'],
  },
  {
    publicName: 'V2.0 alpha',
    apiValue: 'ah_part_extractor_v20_alpha',
    aliases: ['v2.0 alpha', 'v2 alpha', 'v2.0-alpha', 'v2-alpha', '2.0 alpha'],
  },
  {
    publicName: 'V2.1 alpha',
    apiValue: 'ah_part_extractor_v21_alpha',
    aliases: ['v2.1 alpha', 'v2.1-alpha', '2.1 alpha'],
  },
  {
    publicName: 'V3.6.1',
    apiValue: 'ah_agent_graph_v3_6_1',
    aliases: ['v3.6.1', '3.6.1', 'v3.6.1 primary images first'],
  },
  {
    publicName: 'V3.6.3 Fast Analysis',
    apiValue: 'ah_agent_graph_v3_6_3',
    aliases: ['v3.6.3', '3.6.3'],
  },
  {
    publicName: 'V3.6.4 Fast Analysis',
    apiValue: 'ah_agent_graph_v3_6_4',
    aliases: ['v3.6.4', '3.6.4'],
  },
  {
    publicName: 'V3.6.5 Primary Images',
    apiValue: 'ah_agent_graph_v3_6_5',
    aliases: ['v3.6.5', '3.6.5'],
  },
  {
    publicName: 'Chibi Character (Pluffy) v3.1',
    apiValue: 'ah_agent_graph_pluffy_v3_1',
    aliases: ['pluffy', 'pluffy v3.1', 'pluffy 3.1'],
  },
] as const satisfies readonly PartExtractorOption[]

const partExtractorPublicNames = partExtractorOptions
  .map(option => option.publicName)
  .join(', ')

const normalizePartExtractorName = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ')

const partExtractorByInput = new Map<string, PartExtractorOption>(
  partExtractorOptions.flatMap(option => [
    [normalizePartExtractorName(option.publicName), option],
    ...option.aliases.map(
      alias => [normalizePartExtractorName(alias), option] as const,
    ),
  ]),
)

const partExtractorPublicNameByApiValue = new Map<string, string>(
  partExtractorOptions.map(option => [option.apiValue, option.publicName]),
)

const isInternalPartExtractorId = (value: string): boolean =>
  value.trim().includes('_')

const execFileAsync = promisify(execFile)

export const usage = `AssetHub CLI

CLI and MCP are available to all AssetHub users. Workspace permissions and feature availability apply.

Usage:
  assethub --version
  assethub doctor [--mcp] [--profile <name>] [--timeout-ms <n>]
  assethub mcp tools [tool-name] [--account] [--profile <name>] [--timeout-ms <n>]
  assethub mcp config --client cursor|codex [--account] [--base-url <url>]
  assethub auth login --api-key <key> [--base-url <url>] [--profile <name>]
  assethub auth login --api-key-stdin [--base-url <url>] [--profile <name>]
  assethub auth login --access-token-stdin [--base-url <url>] [--profile <name>]
  assethub auth status [--profile <name>]
  assethub auth logout [--profile <name>]
  assethub workspace list [--query <text>] [--limit <1-100>] [--cursor <cursor>]
  assethub workspace get
  assethub workspace create --name <name> [--operation-id <uuid>]
  assethub workspace use <workspace-id>
  assethub workspace members [--workspace <id>]
  assethub workspace invite --email <email> [--role user|admin] [--resend] [--workspace <id>]
  assethub workspace set-role <user-id> --role user|admin [--workspace <id>]
  assethub workspace remove-member <user-id> [--workspace <id>]
  assethub workspace prepare|sync|analyze|verify --internal --manifest <json> --state <json>
  assethub workspace self-check --internal
  assethub workspace context put --internal --org <uuid> --actor <uuid> --canvas <id> --file <json> [--if-version <n>] [--order <uuid>]
  assethub workspace context get --internal --org <uuid> --actor <uuid> --canvas <id> [--out <json>] [--order <uuid>]
  assethub project ingest <source-dir> --out-dir <directory> [--exclude-dir <relative-path>...]
  assethub language text|vision --input-json @<json> --operation-id <uuid> [--out <json>]
  assethub canvas download --canvas <id> --out-dir <directory> [--mesh <mesh_asset_id>]
  assethub canvas nodes --canvas <id>
  assethub canvas import --canvas <id> --file <image> [--name <name>]
  assethub canvas context get --canvas <id> [--out <json>]
  assethub canvas context put --canvas <id> --file <json> [--if-version <n>]
  assethub canvas layout --canvas <id> --input-json @<json>
  assethub canvas compare --canvas <id> --source-id <asset-id> --asset-id <asset-id> --out <html>
  assethub moodboard create --input-json @<json> [--operation-id <uuid>]
  assethub moodboard list|get|update|archive [<board-id>] [--input-json @<json>]
  assethub moodboard analyze <board-id> [--revision <uuid>] [--wait]
  assethub image generate --canvas <id> --context <id> [--context-version <n>] [--context-source <key>] [--moodboard-revision <uuid>] --prompt <text> --wait
  assethub models list [--domain <domain>] [--ids-only] [--limit <n>]
  assethub models get <model-id>
  assethub files import <url> --media-type image|mesh
  assethub files upload <file> --media-type image|mesh
  assethub source create (--file <path> | --source-url <url> | --source-id <id> | --stdin | --stdin-base64 | --stdin-data-uri | --stdin-json | --source-json <json|@file|@-> | --data-uri <uri> | --clipboard) --media-type image|mesh [--file-name <name>] [--content-type <type>]
  assethub capabilities
  assethub composer models
  assethub composer refine --list-modes
  assethub composer refine --from-run <run-id> --instruction <text> [--mode standard|thorough|placement|workshop|blender] [--max-rounds <n>] [--transforms-json <json|@file>] [--wait] [--download --out-dir <dir>]
  assethub composer refine --input-json <json|@file> [--canvas <id>] [--operation-id <uuid>] [--wait] [--download --out-dir <dir>]
  assethub composer run --part <mesh-asset-id> [--part <mesh-asset-id>...] --reference <image-asset-id> [--model <id>] [--mode quick|quality] [--transforms-json <json|@file>] [--canvas <id>] [--wait]
  assethub composer run --input-json <json|@file> [--canvas <id>] [--operation-id <uuid>] [--wait] [--download --out-dir <dir>]
  assethub composer run --from-run <run-id> [--transforms-json <json|@file>] [--mode quick|quality] [--wait]
  assethub composer run --node <shape:id> --canvas <id> [--model <id>] [--mode quick|quality] [--operation-id <uuid>] [--wait]
  assethub canvas create [--name <name>] [--operation-id <uuid>]
  assethub canvas list [--cursor <cursor>] [--limit <n>]
  assethub canvas get|use|open [<id>]
  assethub runs list [--canvas <id>] [--cursor <cursor>] [--limit <n>]
  assethub runs get|watch <run-id> [--timeout-ms <n>]
  assethub runs resume <operation-id> [--wait]
  assethub graph list [--cursor <cursor>] [--limit <n>]
  assethub graph show|export [--canvas <id> | --graph <id>] [--source generated|upload] [--artifact <node-id>] [--out <path>] [--allow-truncated]
  assethub graph lineage --artifact <node-id> [--canvas <id> | --graph <id>] [--source generated|upload] [--direction ancestors|descendants|both] [--depth <n>] [--out <path>]
  assethub evaluate list
  assethub evaluations submit --artifact <asset-id> --report <json|file|@file|@-> [--agent <name>] [--canvas <id>] [--reference <asset-id>...] [--run <run-id>] [--operation-id <uuid>] [--require-pass]
  assethub evaluations list [--canvas <id>] [--artifact <asset-id>]
  assethub evaluations get <evaluation-id>
  assethub image generate --input-json <json|@file|@-> [--canvas <id>] [--operation-id <uuid>] [--agent <name>] [--derived-from-run <run-id>] [--from-node <graphId/nodeId> --graph-revision <rev>] [--wait]
  assethub mesh generate --input-json <json|@file|@-> [--canvas <id>] [--operation-id <uuid>] [--agent <name>] [--derived-from-run <run-id>] [--from-node <graphId/nodeId> --graph-revision <rev>] [--wait]
  assethub mesh generate --node <shape:id> --canvas <id> [--model-id <id>] [--params-json <json|@file>] [--operation-id <uuid>] [--wait]
  assethub mesh list [--query <text>] [--cursor <cursor>] [--limit <n>]
  assethub mesh get <mesh-asset-id>
  assethub mesh download <mesh-asset-id> --out-dir <directory>
  assethub image generate --prompt <text> [--file <path> | --source-url <url> | --stdin | --stdin-base64 | --stdin-data-uri | --stdin-json | --source-json <json|@file|@-> | --data-uri <uri> | --clipboard] [--file-name <name>] [--content-type <type>] [--model-id <id>] [--batch-size <n>] [--wait] [--download --out-dir <dir>] [--canvas <id>] [--operation-id <uuid>] [--api-version v2]
  assethub image generate --prompt <text> --source-resource-id <id> --api-version v2 [--model-id <id>] [--batch-size <n>] [--wait]
  assethub mesh generate (--file <path> | --source-url <url> | --source-resource-id <id> | --file-ref-json <json> | --stdin | --stdin-base64 | --stdin-data-uri | --stdin-json | --source-json <json|@file|@-> | --data-uri <uri>) [--file-name <name>] [--content-type <type>] [--model-id <id>] [--name <name>] [--wait] [--download --out-dir <dir>]
  assethub mesh retopo (--source-resource-id <id> | --source-url <url> | --file-ref-json <json> | --stdin | --stdin-base64 | --stdin-data-uri | --stdin-json | --source-json <json|@file|@-> | --data-uri <uri>) --model-id <id> [--file-name <name>] [--content-type <type>] [--wait] [--download --out-dir <dir>]
  assethub rig check (--file <path> | --source-url <url> | --source-resource-id <id> | --file-ref-json <json> | --stdin | --stdin-base64 | --stdin-data-uri | --stdin-json | --source-json <json|@file|@-> | --data-uri <uri>) [--name <name>] [--wait] [--download --out-dir <dir>]
  assethub rig create (--file <path> | --source-url <url> | --source-resource-id <id> | --file-ref-json <json> | --stdin | --stdin-base64 | --stdin-data-uri | --stdin-json | --source-json <json|@file|@-> | --data-uri <uri>) [--model v1.0-20240301|v2.5-20260210] [--rig-type biped|quadruped|hexapod|octopod|avian|serpentine|aquatic] [--spec tripo|mixamo] [--out-format glb|fbx] [--name <name>] [--wait] [--download --out-dir <dir>]
  assethub animate presets [--model v1.0-20240301|v2.5-20260210] [--rig-type <type>]
  assethub animate retarget --resource-id <id> --animation <preset-id> [--animation <preset-id>... up to 5 total] [--out-format glb|fbx] [--bake-animation true|false] [--export-with-geometry true|false] [--animate-in-place true|false] [--name <name>] [--wait] [--download --out-dir <dir>]
  assethub jobs get <job-id> [--download --out-dir <dir>]
  assethub jobs watch <job-id> [--interval-ms <ms>] [--timeout-ms <ms>] [--download --out-dir <dir>]
  assethub production analyze (--file <path> | --source-url <url> | --source-id <id> | --image-url <url> | --file-ref-json <json> | --stdin | --stdin-base64 | --stdin-data-uri | --stdin-json | --source-json <json|@file|@-> | --data-uri <uri> | --clipboard) [--file-name <name>] [--content-type <type>] [--part-extractor <name>] [--name <name>] [--wait] [--download --out-dir <dir>]
  assethub production agents
  assethub production automation --input-json <json|@file|@-> [--canvas <id>] [--operation-id <uuid>] [--wait]
  assethub production status <order-id> [--wait] [--download --out-dir <dir>]
  assethub production execute --order-id <id> --mission-id <id> --task-id <id> [--task-id <id>...] [--part-extractor <name>] [--part-extraction-mode fast|high_quality] [--wait] [--download --out-dir <dir>]
  assethub production run --order-id <id> --mission-id <id> [--run-mode full_auto|approval] [--task-id <id>...] [--part-extractor <name>] [--part-extraction-mode fast|high_quality] [--allowed-model-id <id>...] [--max-iterations <n>] [--max-cost-credits <n>] [--wait] [--download --out-dir <dir>]
  assethub production watch <order-id> [--interval-ms <ms>] [--timeout-ms <ms>] [--download --out-dir <dir>]
  assethub production intervene <order-id> (--exclude <target-id> | --include <target-id> | --add-part <name> | --rename <target-id>=<name> | --reject <target-id>[=<reason>] | --regenerate <target-id>=<mode> | --set-param <key>=<value> | --ops-json <json|@file|@->)... [--idempotency-key <key>]
  assethub production interventions <order-id>
  assethub runs upload <path> [--graph-id <id>] [--stream-id <id>] [--rev <n>] [--description <text>] [--tag <tag>...] [--skip-register] [--dry-run]
  assethub parts split (--file <path> | --source-url <url> | --source-id <id> | --image-url <url> | --file-ref-json <json> | --stdin | --stdin-base64 | --stdin-data-uri | --stdin-json | --source-json <json|@file|@-> | --data-uri <uri> | --clipboard | --order-id <id>) [--file-name <name>] [--content-type <type>] [--part-extractor <name>] [--wait] [--task-id <id>...] [--mission-id <id>] [--all-ready] [--download --out-dir <dir>]
  assethub parts compare (--file <path> | --source-url <url> | --source-id <id> | --image-url <url> | --file-ref-json <json> | --stdin | --stdin-base64 | --stdin-data-uri | --stdin-json | --source-json <json|@file|@-> | --data-uri <uri> | --clipboard) [--file-name <name>] [--content-type <type>] [--preprocess-prompt <text>] [--preprocess-model-id <id>] [--fail-on-preprocess-error] [--part-extractor <name>] [--wait] [--task-id <id>...] [--mission-id <id>] [--all-ready] [--download --out-dir <dir>]
  assethub autopilot [<image>] --demo [--yolo] [--json] [--max-regen <n>] [--stall-rounds <n>] [--tie-epsilon <x>] [--multiview 2-view|4-view|6-view] [--ab-mode serial|cross] [--credit-budget <n>]

Global options:
  --api-key <key>       Overrides saved auth and ASSETHUB_API_KEY.
  --base-url <url>      Override the selected API origin. Default: ${defaultBaseUrl}.
  --profile <name>      Select this saved profile ahead of environment credentials and origin.
  --workspace <id>      Select workspace scope for this command without changing saved selection.
  --config <path>       Auth config path. Defaults to ~/.assethub/config.json.
  --version             Show installed package version.
  --help                Show help.

Examples:
  ASSETHUB_API_KEY=ah_live_xxx assethub models list
  assethub auth login --api-key-stdin
  assethub models list --ids-only
  assethub files upload ./input.png --media-type image
  assethub source create --file ./input.png --media-type image
  pbpaste | assethub source create --stdin-data-uri --media-type image
  assethub source create --clipboard --media-type image --file-name clipboard.png
  printf '{"image_url":{"url":"data:image/png;base64,..."}}' | assethub parts split --stdin-json --part-extractor "V1.5" --wait
  base64 -i ./input.png | assethub parts split --stdin-base64 --file-name input.png --content-type image/png --part-extractor "V1.5" --wait
  cat ./input.png | assethub parts split --stdin --file-name input.png --part-extractor "V1.5" --wait
  assethub image generate --prompt "stylized prop concept" --wait
  assethub mesh generate --file ./input.png --wait
  assethub animate presets --rig-type biped
  assethub rig create --source-resource-id mesh_x --rig-type biped --wait
  assethub animate retarget --resource-id rig_x --animation preset:idle --wait
  assethub production analyze --file ./input.png --part-extractor "V1.5" --wait
  assethub production run --order-id ord_x --mission-id ms_x --run-mode full_auto --max-cost-credits 200 --wait
  assethub production watch ord_x
  assethub production intervene ord_x --exclude 7 --rename 3="left wing" --idempotency-key review-2026-07-29
  assethub production interventions ord_x
  assethub runs upload ./out/pluffy-run-2026-07-30 --dry-run
  assethub runs upload ./out/pluffy-run-2026-07-30 --tag pluffy --description "V3 humanoid, 18 parts"
  assethub parts split --file ./input.png --part-extractor "V1.5" --wait --all-ready
  assethub parts compare --file ./input.png --preprocess-prompt "clean white background, centered product photo" --part-extractor "V1.5" --wait --all-ready
`

const print = (value: unknown): void => {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

const parseArgs = (args: string[]): ParsedArgs => {
  const positionals: string[] = []
  const flags: Flags = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }

    const withoutPrefix = arg.slice(2)
    const [rawKey, inlineValue] = withoutPrefix.split(/=(.*)/s, 2)
    const key = rawKey.trim()
    if (key.length === 0) {
      throw new Error(`Invalid flag: ${arg}`)
    }

    const next = args[index + 1]
    const value =
      inlineValue != null
        ? inlineValue
        : next != null && !next.startsWith('--')
          ? ((index += 1), next)
          : true

    const previous = flags[key]
    if (previous == null) {
      flags[key] = value
    } else if (Array.isArray(previous)) {
      previous.push(String(value))
    } else {
      flags[key] = [String(previous), String(value)]
    }
  }

  return {positionals, flags}
}

const getFlag = (flags: Flags, name: string): string | undefined => {
  const value = flags[name]
  if (value == null || value === false) {
    return undefined
  }
  if (value === true) {
    return 'true'
  }
  if (Array.isArray(value)) {
    return value[value.length - 1]
  }
  return value
}

const getFlagValues = (flags: Flags, name: string): string[] => {
  const value = flags[name]
  if (value == null || value === false) {
    return []
  }
  if (value === true) {
    return ['true']
  }
  return Array.isArray(value) ? value : [value]
}

const hasFlag = (flags: Flags, name: string): boolean => flags[name] != null

const requireFlag = (flags: Flags, name: string): string => {
  const value = getFlag(flags, name)
  if (value == null || value.trim().length === 0 || value === 'true') {
    throw new Error(`Missing required flag: --${name}`)
  }
  return value
}

const getPartExtractorFlag = (flags: Flags): string | undefined =>
  getFlag(flags, 'part-extractor') ??
  getFlag(flags, 'part-extractor-version') ??
  getFlag(flags, 'agent-version')

const resolvePartExtractorPublicName = (value: string): string => {
  if (isInternalPartExtractorId(value)) {
    throw new Error(
      `Internal part extractor IDs are not accepted by the public CLI. Use one of: ${partExtractorPublicNames}.`,
    )
  }

  const option = partExtractorByInput.get(normalizePartExtractorName(value))
  if (option == null) {
    throw new Error(
      `Unknown part extractor: ${value}. Use one of: ${partExtractorPublicNames}.`,
    )
  }
  return option.publicName
}

const resolvePartExtractorApiValue = (value: string): string => {
  if (isInternalPartExtractorId(value)) {
    throw new Error(
      `Internal part extractor IDs are not accepted by the public CLI. Use one of: ${partExtractorPublicNames}.`,
    )
  }

  const option = partExtractorByInput.get(normalizePartExtractorName(value))
  if (option == null) {
    throw new Error(
      `Unknown part extractor: ${value}. Use one of: ${partExtractorPublicNames}.`,
    )
  }
  return option.apiValue
}

const resolvePartExtractorForAnalyze = (flags: Flags): string =>
  resolvePartExtractorApiValue(
    getPartExtractorFlag(flags) ?? defaultPartExtractorName,
  )

const publicPartExtractorName = (
  value: string | null | undefined,
): string | null => {
  if (value == null) {
    return null
  }
  return (
    partExtractorPublicNameByApiValue.get(value) ??
    (isInternalPartExtractorId(value) ? 'Unknown' : value)
  )
}

const sanitizeProductionOutput = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeProductionOutput(item))
  }
  if (value == null || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'publicAccessToken')
      .map(([key, entry]) => [
        key,
        key === 'execution'
          ? entry
          : key === 'agentVersion' && typeof entry === 'string'
            ? publicPartExtractorName(entry)
            : sanitizeProductionOutput(entry),
      ]),
  )
}

const parsePositiveIntegerFlag = (
  flags: Flags,
  name: string,
  fallback: number,
): number => {
  const raw = getFlag(flags, name)
  if (raw == null) {
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive number`)
  }
  return Math.floor(parsed)
}

const parseBooleanFlag = (flags: Flags, name: string): boolean | undefined => {
  const raw = getFlag(flags, name)
  if (raw == null) {
    return undefined
  }
  if (raw === 'true') {
    return true
  }
  if (raw === 'false') {
    return false
  }
  throw new Error(`--${name} must be true or false`)
}

/**
 * An optional flag whose value must come from a fixed set.
 *
 * The server stays the authority on what it accepts; this only turns a typo
 * into an immediate local error that names the valid values, instead of a
 * round trip that comes back as an opaque 400. Same contract as
 * `parseBooleanFlag`: absent means `undefined`, present-but-wrong throws.
 */
const parseEnumFlag = <const T extends readonly string[]>(
  flags: Flags,
  name: string,
  allowed: T,
): T[number] | undefined => {
  const raw = getFlag(flags, name)
  if (raw == null) {
    return undefined
  }
  if ((allowed as readonly string[]).includes(raw)) {
    return raw as T[number]
  }
  throw new Error(`--${name} must be one of: ${allowed.join(', ')}`)
}

const parseMediaType = (value: string): FileMediaType => {
  if (value === 'image' || value === 'mesh') {
    return value
  }
  throw new Error('--media-type must be "image" or "mesh"')
}

const defaultFileNameForMediaType = (mediaType: FileMediaType): string =>
  mediaType === 'image' ? 'stdin.png' : 'stdin.glb'

const getSourceResourceIdFlag = (flags: Flags): string | undefined =>
  getFlag(flags, 'source-resource-id') ??
  getFlag(flags, 'source-id') ??
  getFlag(flags, 'resource-id')

const getProfileName = (flags: Flags): string =>
  hasFlag(flags, 'profile') ? requireFlag(flags, 'profile') : defaultProfileName

const getConfigPath = (flags: Flags): string =>
  getFlag(flags, 'config') ??
  env.ASSETHUB_CLI_CONFIG ??
  join(homedir(), '.assethub', 'config.json')

const readAuthConfig = async (configPath: string): Promise<AuthConfig> => {
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as AuthConfig
    return {
      defaultProfile: parsed.defaultProfile,
      profiles: parsed.profiles ?? {},
    }
  } catch (error) {
    if (
      error != null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return {profiles: {}}
    }
    throw error
  }
}

const writeAuthConfig = async (
  configPath: string,
  config: AuthConfig,
): Promise<void> => {
  await mkdir(dirname(configPath), {recursive: true, mode: 0o700})
  const temporary = `${configPath}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  })
  await rename(temporary, configPath)
  await chmod(configPath, 0o600)
}

const readStdin = async (): Promise<string> =>
  await new Promise((resolve, reject) => {
    let value = ''
    stdin.setEncoding('utf8')
    stdin.on('data', chunk => {
      value += chunk
    })
    stdin.on('end', () => resolve(value))
    stdin.on('error', reject)
  })

const readStdinBlob = async (type?: string): Promise<Blob> =>
  await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stdin.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    })
    stdin.on('end', () => {
      const buffer = Buffer.concat(chunks)
      const arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer
      resolve(new Blob([arrayBuffer], type == null ? undefined : {type}))
    })
    stdin.on('error', reject)
  })

const isPersonalProfile = (profile?: Pick<AuthProfile, 'apiKey' | 'authentication'>) =>
  profile?.authentication === 'personal' || Boolean(profile?.apiKey?.startsWith('ah_pat_'))

const personalProfileAuthentication = (apiKey: string, baseUrl: string, profile?: AuthProfile) =>
  profile?.apiKey === apiKey && new URL(profile.baseUrl).origin === new URL(baseUrl).origin
    ? profile.authentication : undefined

const canDiscoverPersonalKey = (key?: string) =>
  Boolean(key && (key.startsWith('ah_pat_') || /^sk_[a-f0-9]{64}$/i.test(key)))

const preferredApiKey = (flags: Flags, stored?: AuthProfile) =>
  getFlag(flags, 'api-key') ??
  (hasFlag(flags, 'profile') || stored?.workspaceId || isPersonalProfile(stored)
    ? stored?.apiKey
    : env.ASSETHUB_API_KEY?.trim() || stored?.apiKey)

const personalAccount = async (auth: Pick<ResolvedAuth, 'apiKey' | 'baseUrl' | 'workspaceId' | 'authentication'>) => {
  const knownPersonal = isPersonalProfile(auth)
  if (!knownPersonal && !canDiscoverPersonalKey(auth.apiKey)) return undefined
  try {
    const account = await createWorkspaceClient({accessToken: auth.apiKey, baseUrl: auth.baseUrl, workspaceId: auth.workspaceId}).list()
    if (account.authentication !== 'personal') throw new Error('Workspace API did not verify personal authentication')
    return account
  } catch (error) {
    if (!knownPersonal && error instanceof WorkspaceClientError && error.status === 401 && error.code === 'PERSONAL_KEY_NOT_REGISTERED') return undefined
    throw error
  }
}

const rememberPersonalProfile = async (auth: ResolvedAuth, configPath: string, config: AuthConfig, userId: string) => {
  if (auth.source !== 'profile') return
  config.profiles = {...config.profiles, [auth.profile]: {
    apiKey: auth.apiKey, authentication: 'personal', userId,
    workspaceId: config.profiles?.[auth.profile]?.workspaceId, baseUrl: auth.baseUrl, updatedAt: new Date().toISOString(),
  }}
  await writeAuthConfig(configPath, config)
}

const resolveAuth = async (flags: Flags): Promise<ResolvedAuth> => {
  const explicitProfile = hasFlag(flags, 'profile') ? requireFlag(flags, 'profile') : undefined
  const overrideKey = hasFlag(flags, 'api-key') ? requireFlag(flags, 'api-key') : undefined
  const config =
    !overrideKey || explicitProfile
      ? await readAuthConfig(getConfigPath(flags))
      : undefined
  const profile = explicitProfile ?? config?.defaultProfile ?? defaultProfileName
  const storedProfile = config?.profiles?.[profile]
  const selected = Boolean(explicitProfile || storedProfile?.workspaceId || isPersonalProfile(storedProfile))
  if (selected && (!storedProfile || (!storedProfile.apiKey && !overrideKey)))
    throw new Error(
      'Selected profile has no workspace API key. Use workspace use <id> or auth login --api-key-stdin --profile <name>.',
    )
  const baseUrl =
    getFlag(flags, 'base-url') ??
    (selected
      ? storedProfile!.baseUrl
      : env.ASSETHUB_API_BASE_URL ?? storedProfile?.baseUrl ?? defaultBaseUrl)
  if (overrideKey)
    return {apiKey: overrideKey, baseUrl, profile, source: 'flag', workspaceId: getFlag(flags, 'workspace')}
  if (selected && storedProfile?.apiKey) {
    if (
      (storedProfile.workspaceId || isPersonalProfile(storedProfile) || canDiscoverPersonalKey(storedProfile.apiKey)) &&
      new URL(baseUrl).origin !== new URL(storedProfile.baseUrl).origin
    )
      throw new Error(
        'Selected workspace belongs to another API origin; select a workspace for this origin or supply an explicit API key',
      )
    return {apiKey: storedProfile.apiKey, authentication: storedProfile.authentication, baseUrl, profile, source: 'profile', workspaceId: getFlag(flags, 'workspace') ?? storedProfile.workspaceId}
  }
  if (env.ASSETHUB_API_KEY?.trim())
    return {apiKey: env.ASSETHUB_API_KEY, baseUrl, profile, source: 'env', workspaceId: getFlag(flags, 'workspace')}
  if (storedProfile?.apiKey) {
    if (canDiscoverPersonalKey(storedProfile.apiKey) && new URL(baseUrl).origin !== new URL(storedProfile.baseUrl).origin)
      throw new Error('Saved API key belongs to another API origin; supply an explicit API key for this origin')
    return {apiKey: storedProfile.apiKey, baseUrl, profile, source: 'profile', workspaceId: getFlag(flags, 'workspace') ?? storedProfile.workspaceId}
  }
  throw new Error(
    'Missing workspace API key. Use "workspace use <id>" after user login, "auth login --api-key-stdin", or ASSETHUB_API_KEY.',
  )
}

const createContext = async (
  flags: Flags,
  args: string[],
): Promise<CommandContext> => {
  const auth = await resolveAuth(flags)
  return {
    args,
    auth,
    flags,
    client: createAssetHubClient({
      apiKey: auth.apiKey,
      baseUrl: auth.baseUrl,
      workspaceId: auth.workspaceId,
    }),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

const isBlobLocation = (value: unknown): value is BlobLocation => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false
  }
  if (
    value.type === 'supabase' &&
    typeof value.bucket === 'string' &&
    typeof value.path === 'string'
  ) {
    return true
  }
  if (value.type === 'signedSupabase' && typeof value.signedUrl === 'string') {
    return true
  }
  if (value.type === 'asset' && typeof value.assetId === 'string') {
    return true
  }
  return false
}

const parseFileRef = (value: string): BlobLocation => {
  const parsed = JSON.parse(value) as unknown
  if (!isBlobLocation(parsed)) {
    throw new Error('--file-ref-json must be a BlobLocation JSON object')
  }
  return parsed
}

const blobFromBuffer = (buffer: Buffer, type?: string): Blob => {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer
  return new Blob([arrayBuffer], type == null ? undefined : {type})
}

const readBlob = async (filePath: string, type?: string): Promise<Blob> =>
  blobFromBuffer(await readFile(filePath), type)

const getContentTypeFlag = (flags: Flags): string | undefined =>
  getFlag(flags, 'content-type') ?? getFlag(flags, 'mime-type')

const blobFromDataUri = (
  value: string,
  flagName = '--data-uri',
): {blob: Blob; contentType?: string} => {
  const trimmed = value.trim()
  const match = trimmed.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (match == null) {
    throw new Error(`${flagName} must be a valid data URI.`)
  }

  const contentType = match[1] === '' ? undefined : match[1]
  const isBase64 = match[2] != null
  const payload = (match[3] ?? '').replace(/\s+/g, '')
  const buffer = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8')
  return {
    blob: blobFromBuffer(buffer, contentType),
    contentType,
  }
}

const blobFromBase64 = (
  value: string,
  contentType: string | undefined,
  flagName: string,
): {blob: Blob; contentType?: string} => {
  const trimmed = value.trim()
  if (trimmed.startsWith('data:')) {
    return blobFromDataUri(trimmed, flagName)
  }
  const normalized = trimmed
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  if (normalized === '') {
    throw new Error(`${flagName} input is empty.`)
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error(`${flagName} must contain base64 data or a data URI.`)
  }
  const buffer = Buffer.from(normalized, 'base64')
  if (buffer.byteLength === 0) {
    throw new Error(`${flagName} did not decode to any bytes.`)
  }
  return {
    blob: blobFromBuffer(buffer, contentType),
    contentType,
  }
}

const extensionFromMimeType = (
  mimeType: string | undefined,
  mediaType: FileMediaType,
): string => {
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/gif') return 'gif'
  if (mimeType === 'model/gltf-binary') return 'glb'
  if (mimeType === 'model/gltf+json') return 'gltf'
  return mediaType === 'image' ? 'png' : 'glb'
}

const contentTypeFromExtension = (extension: string): string | undefined => {
  switch (extension.toLowerCase()) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    case 'tif':
    case 'tiff':
      return 'image/tiff'
    case 'glb':
      return 'model/gltf-binary'
    case 'gltf':
      return 'model/gltf+json'
    case 'obj':
      return 'model/obj'
    case 'fbx':
      return 'application/fbx'
    case 'stl':
      return 'model/stl'
    case 'ply':
      return 'text/plain'
    case 'usdz':
      return 'model/vnd.usdz+zip'
    case 'usd':
    case 'usdc':
      return 'model/vnd.usd'
    default:
      return undefined
  }
}

const isNonspecificContentType = (contentType: string | undefined): boolean => {
  const clean = contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  return (
    clean === '' ||
    clean === 'application/octet-stream' ||
    clean === 'binary/octet-stream'
  )
}

const inferContentTypeFromFileName = (fileName: string): string | undefined => {
  const extension = extname(fileName).replace(/^\./, '')
  if (extension === '') return undefined
  return contentTypeFromExtension(extension)
}

const resolveUploadContentType = (
  fileName: string,
  explicitContentType?: string,
): string | undefined => {
  if (!isNonspecificContentType(explicitContentType)) {
    return explicitContentType
  }
  return inferContentTypeFromFileName(fileName)
}

const ensureFileNameExtension = (
  fileName: string,
  mediaType: FileMediaType,
  mimeType?: string,
): string => {
  if (extname(fileName) !== '') {
    return fileName
  }
  return `${fileName}.${extensionFromMimeType(mimeType, mediaType)}`
}

const missingSourceMessage =
  'Missing source. Pass --file, --source-url, --source-resource-id, --source-id, --file-ref-json, --stdin, --stdin-base64, --stdin-data-uri, --stdin-json, --source-json, --data-uri, or --clipboard.'

const exactlyOneSourceMessage =
  'Pass exactly one source input: --file, --source-url/--image-url, --source-id/--source-resource-id, --file-ref-json, --stdin, --stdin-base64, --stdin-data-uri, --stdin-json, --source-json, --data-uri, or --clipboard.'

const getSourceUrlFlag = (flags: Flags): string | undefined =>
  getFlag(flags, 'source-url') ??
  getFlag(flags, 'image-url') ??
  getFlag(flags, 'url')

const assertFlagHasValue = (value: string, flagDescription: string): string => {
  if (value === 'true' || value.trim() === '') {
    throw new Error(`Missing required flag value: ${flagDescription}`)
  }
  return value
}

const sourceInputCount = (flags: Flags): number =>
  [
    getSourceResourceIdFlag(flags) != null,
    getSourceUrlFlag(flags) != null,
    getFlag(flags, 'file-ref-json') != null,
    getFlag(flags, 'file') != null,
    getFlag(flags, 'data-uri') != null,
    hasFlag(flags, 'stdin'),
    hasFlag(flags, 'stdin-base64'),
    hasFlag(flags, 'stdin-data-uri'),
    hasFlag(flags, 'stdin-json'),
    getFlag(flags, 'source-json') != null,
    hasFlag(flags, 'clipboard'),
  ].filter(Boolean).length

const sourceFromString = (value: string): Source | undefined => {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.startsWith('data:')) {
    return undefined
  }
  try {
    const url = new URL(trimmed)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return {url: trimmed}
    }
  } catch {
    // Ignore non-URL strings.
  }
  return undefined
}

const getFirstString = (
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value
    }
  }
  return undefined
}

const stringFromJsonImageUrl = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim() !== '') {
    return value
  }
  if (isRecord(value)) {
    return getFirstString(value, ['url'])
  }
  return undefined
}

const descriptorFromDataUri = (
  value: string,
  mediaType: FileMediaType,
  fileName: string,
  flagName: string,
): SourceDescriptor => {
  const {blob, contentType} = blobFromDataUri(value, flagName)
  return {
    kind: 'blob',
    blob,
    fileName: ensureFileNameExtension(fileName, mediaType, contentType),
    contentType,
  }
}

const descriptorFromBase64 = ({
  value,
  contentType,
  fileName,
  mediaType,
  flagName,
}: {
  value: string
  contentType?: string
  fileName: string
  mediaType: FileMediaType
  flagName: string
}): SourceDescriptor => {
  const decoded = blobFromBase64(value, contentType, flagName)
  return {
    kind: 'blob',
    blob: decoded.blob,
    fileName: ensureFileNameExtension(fileName, mediaType, decoded.contentType),
    contentType: decoded.contentType,
  }
}

const sourceDescriptorFromJson = (
  value: unknown,
  options: {
    mediaType: FileMediaType
    fallbackFileName: string
  },
): SourceDescriptor | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') {
      return undefined
    }
    if (trimmed.startsWith('data:')) {
      return descriptorFromDataUri(
        trimmed,
        options.mediaType,
        options.fallbackFileName,
        '--source-json',
      )
    }
    const source = sourceFromString(trimmed)
    return source == null ? undefined : {kind: 'source', source}
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = sourceDescriptorFromJson(item, options)
      if (found != null) {
        return found
      }
    }
    return undefined
  }

  if (!isRecord(value)) {
    return undefined
  }

  const nestedSource = value.source
  if (nestedSource != null) {
    const found = sourceDescriptorFromJson(nestedSource, options)
    if (found != null) {
      return found
    }
  }

  const imageUrl = stringFromJsonImageUrl(value.image_url ?? value.imageUrl)
  if (imageUrl != null) {
    if (imageUrl.trim().startsWith('data:')) {
      return descriptorFromDataUri(
        imageUrl,
        options.mediaType,
        options.fallbackFileName,
        '--source-json',
      )
    }
    return {kind: 'source', source: {url: imageUrl}}
  }

  const resourceId = getFirstString(value, [
    'resourceId',
    'resource_id',
    'sourceResourceId',
    'source_resource_id',
    'sourceId',
    'source_id',
    'imageAssetId',
    'image_asset_id',
    'assetId',
    'asset_id',
  ])
  if (resourceId != null) {
    return {kind: 'source', source: {resourceId}}
  }

  const uploadId = getFirstString(value, ['uploadId', 'upload_id'])
  if (uploadId != null) return {kind: 'source', source: {uploadId}}

  const fileRefValue =
    value.fileRef ??
    value.file_ref ??
    value.imageBlobLocation ??
    value.image_blob_location ??
    value.blobLocation ??
    value.blob_location
  if (isBlobLocation(fileRefValue)) {
    return {kind: 'source', source: {fileRef: fileRefValue}}
  }

  const dataUri = getFirstString(value, ['dataUri', 'data_uri'])
  if (dataUri != null) {
    return descriptorFromDataUri(
      dataUri,
      options.mediaType,
      getFirstString(value, ['fileName', 'file_name', 'name']) ??
        options.fallbackFileName,
      '--source-json',
    )
  }

  const contentType = getFirstString(value, [
    'contentType',
    'content_type',
    'mimeType',
    'mime_type',
    'media_type',
  ])
  const base64Value = getFirstString(value, ['base64', 'data', 'content'])
  if (base64Value != null && (value.type === 'base64' || contentType != null)) {
    return descriptorFromBase64({
      value: base64Value,
      contentType,
      fileName:
        getFirstString(value, ['fileName', 'file_name', 'name']) ??
        options.fallbackFileName,
      mediaType: options.mediaType,
      flagName: '--source-json',
    })
  }

  const url = getFirstString(value, [
    'sourceUrl',
    'source_url',
    'url',
    'publicUrl',
    'public_url',
  ])
  if (url != null) {
    const source = sourceFromString(url)
    if (source != null) {
      return {kind: 'source', source}
    }
  }

  const path = getFirstString(value, ['path', 'file', 'filePath', 'file_path'])
  if (path != null) {
    return {kind: 'file', path}
  }

  const preferredKeys = [
    'input',
    'image',
    'asset',
    'file',
    'message',
    'messages',
    'content',
    'attachments',
  ]
  for (const key of preferredKeys) {
    const found = sourceDescriptorFromJson(value[key], options)
    if (found != null) {
      return found
    }
  }

  for (const entry of Object.values(value)) {
    const found = sourceDescriptorFromJson(entry, options)
    if (found != null) {
      return found
    }
  }
  return undefined
}

const parseJsonValue = (raw: string, sourceName: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `${sourceName} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const readSourceJsonFlag = async (flags: Flags): Promise<string> => {
  const value = getFlag(flags, 'source-json')
  if (value == null || value === 'true' || value.trim() === '') {
    throw new Error(
      'Missing required flag value: --source-json <json|@file|@->',
    )
  }
  if (value === '@-' || value === '-') {
    return await readStdin()
  }
  if (value.startsWith('@')) {
    return await readFile(value.slice(1), 'utf8')
  }
  return value
}

const readClipboardImage = async (): Promise<Blob> => {
  const filePath = join(
    tmpdir(),
    `assethub-clipboard-${process.pid}-${Date.now()}.png`,
  )
  const readTempFile = async (): Promise<Blob> =>
    await readBlob(filePath, 'image/png')

  try {
    await execFileAsync('pngpaste', [filePath], {timeout: 10000})
    return await readTempFile()
  } catch (pngpasteError) {
    const quoteAppleScriptString = (value: string): string =>
      `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    const pngClass = `${String.fromCharCode(0x00ab)}class PNGf${String.fromCharCode(0x00bb)}`
    const script = [
      `set outPath to ${quoteAppleScriptString(filePath)}`,
      `set pngData to the clipboard as ${pngClass}`,
      'set fileRef to open for access (POSIX file outPath) with write permission',
      'try',
      'set eof fileRef to 0',
      'write pngData to fileRef',
      'close access fileRef',
      'on error errMsg',
      'try',
      'close access fileRef',
      'end try',
      'error errMsg',
      'end try',
    ].join('\n')
    try {
      await execFileAsync('osascript', ['-e', script], {timeout: 10000})
      return await readTempFile()
    } catch (osascriptError) {
      const details =
        osascriptError instanceof Error
          ? osascriptError.message
          : pngpasteError instanceof Error
            ? pngpasteError.message
            : 'unknown error'
      throw new Error(
        `Could not read an image from the clipboard. Copy an image, install pngpaste, or pass bytes through --stdin/--stdin-base64/--stdin-json. Details: ${details}`,
      )
    }
  } finally {
    await unlink(filePath).catch(() => undefined)
  }
}

const uploadSourceDescriptor = async ({
  descriptor,
  client,
  mediaType,
  preferUploadId,
}: {
  descriptor: SourceDescriptor
  client: ReturnType<typeof createAssetHubClient>
  mediaType: FileMediaType
  preferUploadId?: boolean
}): Promise<Source> => {
  if (descriptor.kind === 'source') {
    return descriptor.source
  }

  const fileName =
    descriptor.kind === 'file' ? basename(descriptor.path) : descriptor.fileName
  const fileNameWithExtension = ensureFileNameExtension(
    fileName,
    mediaType,
    descriptor.contentType,
  )
  const contentType = resolveUploadContentType(
    fileNameWithExtension,
    descriptor.contentType,
  )
  const file =
    descriptor.kind === 'file'
      ? await readBlob(descriptor.path, contentType)
      : isNonspecificContentType(descriptor.blob.type) && contentType != null
        ? new Blob([descriptor.blob], {type: contentType})
        : descriptor.blob
  const upload = await client.v2.uploadFile({
    file,
    fileName: fileNameWithExtension,
    mediaType,
  })
  if (preferUploadId) {
    if (!upload.uploadId)
      throw new Error('Server did not return a durable upload ID')
    return {uploadId: upload.uploadId}
  }
  return {fileRef: upload.fileRef}
}

const resolveSource = async ({
  flags,
  client,
  fileMediaType,
  preferUploadId,
}: {
  flags: Flags
  client: ReturnType<typeof createAssetHubClient>
  fileMediaType: FileMediaType
  preferUploadId?: boolean
}): Promise<Source | undefined> => {
  const providedCount = sourceInputCount(flags)
  if (providedCount === 0) {
    return undefined
  }
  if (providedCount > 1) {
    throw new Error(exactlyOneSourceMessage)
  }

  const sourceResourceId = getSourceResourceIdFlag(flags)
  if (sourceResourceId != null) {
    return {
      resourceId: assertFlagHasValue(
        sourceResourceId,
        '--source-id/--source-resource-id <id>',
      ),
    }
  }

  const sourceUrl = getSourceUrlFlag(flags)
  if (sourceUrl != null) {
    return {
      url: assertFlagHasValue(sourceUrl, '--source-url/--image-url <url>'),
    }
  }

  const fileRefJson = getFlag(flags, 'file-ref-json')
  if (fileRefJson != null) {
    return {
      fileRef: parseFileRef(
        assertFlagHasValue(fileRefJson, '--file-ref-json <json>'),
      ),
    }
  }

  const filePath = getFlag(flags, 'file')
  if (filePath != null) {
    return await uploadSourceDescriptor({
      descriptor: {
        kind: 'file',
        path: assertFlagHasValue(filePath, '--file <path>'),
      },
      client,
      mediaType: fileMediaType,
      preferUploadId,
    })
  }

  const dataUri = getFlag(flags, 'data-uri')
  if (dataUri != null) {
    return await uploadSourceDescriptor({
      descriptor: descriptorFromDataUri(
        assertFlagHasValue(dataUri, '--data-uri <uri>'),
        fileMediaType,
        getFlag(flags, 'file-name') ?? 'data-uri',
        '--data-uri',
      ),
      client,
      mediaType: fileMediaType,
      preferUploadId,
    })
  }

  if (getFlag(flags, 'source-json') != null) {
    const parsed = parseJsonValue(
      await readSourceJsonFlag(flags),
      '--source-json',
    )
    const descriptor = sourceDescriptorFromJson(parsed, {
      mediaType: fileMediaType,
      fallbackFileName:
        getFlag(flags, 'file-name') ??
        defaultFileNameForMediaType(fileMediaType),
    })
    if (descriptor == null) {
      throw new Error(
        '--source-json did not contain a usable source. Expected url, image_url.url, resourceId, fileRef, data URI, base64 data, or path.',
      )
    }
    return await uploadSourceDescriptor({
      descriptor,
      client,
      mediaType: fileMediaType,
      preferUploadId,
    })
  }

  if (hasFlag(flags, 'stdin-json')) {
    const parsed = parseJsonValue(await readStdin(), '--stdin-json')
    const descriptor = sourceDescriptorFromJson(parsed, {
      mediaType: fileMediaType,
      fallbackFileName:
        getFlag(flags, 'file-name') ??
        defaultFileNameForMediaType(fileMediaType),
    })
    if (descriptor == null) {
      throw new Error(
        '--stdin-json did not contain a usable source. Expected url, image_url.url, resourceId, fileRef, data URI, base64 data, or path.',
      )
    }
    return await uploadSourceDescriptor({
      descriptor,
      client,
      mediaType: fileMediaType,
      preferUploadId,
    })
  }

  if (hasFlag(flags, 'stdin-data-uri')) {
    return await uploadSourceDescriptor({
      descriptor: descriptorFromDataUri(
        await readStdin(),
        fileMediaType,
        getFlag(flags, 'file-name') ?? 'stdin-data-uri',
        '--stdin-data-uri',
      ),
      client,
      mediaType: fileMediaType,
      preferUploadId,
    })
  }

  if (hasFlag(flags, 'stdin-base64')) {
    return await uploadSourceDescriptor({
      descriptor: descriptorFromBase64({
        value: await readStdin(),
        contentType: getContentTypeFlag(flags),
        fileName:
          getFlag(flags, 'file-name') ??
          defaultFileNameForMediaType(fileMediaType),
        mediaType: fileMediaType,
        flagName: '--stdin-base64',
      }),
      client,
      mediaType: fileMediaType,
      preferUploadId,
    })
  }

  if (hasFlag(flags, 'clipboard')) {
    if (fileMediaType !== 'image') {
      throw new Error('--clipboard is only supported for image inputs.')
    }
    return await uploadSourceDescriptor({
      descriptor: {
        kind: 'blob',
        blob: await readClipboardImage(),
        fileName: ensureFileNameExtension(
          getFlag(flags, 'file-name') ?? 'clipboard.png',
          fileMediaType,
          'image/png',
        ),
        contentType: 'image/png',
      },
      client,
      mediaType: fileMediaType,
      preferUploadId,
    })
  }

  if (hasFlag(flags, 'stdin')) {
    return await uploadSourceDescriptor({
      descriptor: {
        kind: 'blob',
        blob: await readStdinBlob(getContentTypeFlag(flags)),
        fileName: ensureFileNameExtension(
          getFlag(flags, 'file-name') ??
            defaultFileNameForMediaType(fileMediaType),
          fileMediaType,
          getContentTypeFlag(flags),
        ),
        contentType: getContentTypeFlag(flags),
      },
      client,
      mediaType: fileMediaType,
      preferUploadId,
    })
  }

  return undefined
}

const requireSource = async (options: {
  flags: Flags
  client: ReturnType<typeof createAssetHubClient>
  fileMediaType: FileMediaType
  preferUploadId?: boolean
}): Promise<Source> => {
  const source = await resolveSource(options)
  if (source == null) {
    throw new Error(missingSourceMessage)
  }
  return source
}

const resolveProductionAnalyzeSource = async (
  ctx: CommandContext,
): Promise<ProductionAnalyzeSourceInput> => {
  const source = await recordedSource(
    ctx,
    await requireSource({
      flags: ctx.flags,
      client: ctx.client,
      fileMediaType: 'image',
      preferUploadId: true,
    }),
  )
  return productionAnalyzeSourceFromSource(source!)
}

const productionAnalyzeSourceFromSource = (
  source: Source,
): ProductionAnalyzeSourceInput => {
  if (source.uploadId) return {uploadId: source.uploadId}
  if (source.resourceId) return {imageAssetId: source.resourceId}
  if (source.url) return {imageUrl: source.url}
  if (source.fileRef) return {imageBlobLocation: source.fileRef}
  throw new Error(missingSourceMessage)
}

const sourceFromProductionAnalyzeSource = (
  source: Partial<ProductionAnalyzeSourceInput>,
): Source => {
  if (source.uploadId) return {uploadId: source.uploadId}
  if (source.imageAssetId != null) {
    return {resourceId: source.imageAssetId}
  }
  if (source.imageUrl != null) {
    return {url: source.imageUrl}
  }
  if (source.imageBlobLocation) return {fileRef: source.imageBlobLocation}
  throw new Error(missingSourceMessage)
}

const productionAnalyzeTerminalStatuses = new Set([
  'ready',
  'completed',
  'failed',
])
const productionExecuteTerminalStatuses = new Set(['completed', 'failed'])

type ProductionRunMode = 'approval' | 'full_auto'

const parseRunModeFlag = (flags: Flags): ProductionRunMode => {
  const raw = getFlag(flags, 'run-mode') ?? 'full_auto'
  if (raw === 'approval' || raw === 'full_auto') {
    return raw
  }
  throw new Error('--run-mode must be "approval" or "full_auto"')
}

/**
 * Derive a human-facing run phase from a production status payload. Beyond the
 * raw order status, this surfaces `waiting_approval` — the state an approval
 * run parks in once parts are generated but not yet reviewed.
 */
const deriveRunPhase = (status: unknown): string => {
  const order =
    status != null && typeof status === 'object' && 'order' in status
      ? (status as {order?: {status?: unknown}}).order
      : undefined
  const orderStatus =
    order != null && typeof order.status === 'string' ? order.status : 'unknown'

  if (orderStatus !== 'in_progress') {
    return orderStatus
  }

  const summary =
    status != null && typeof status === 'object' && 'summary' in status
      ? (
          status as {
            summary?: {completedTasks?: unknown; pendingTasks?: unknown}
          }
        ).summary
      : undefined
  const pending =
    summary != null && typeof summary.pendingTasks === 'number'
      ? summary.pendingTasks
      : undefined
  const completed =
    summary != null && typeof summary.completedTasks === 'number'
      ? summary.completedTasks
      : undefined

  if (pending === 0 && completed != null && completed > 0) {
    return 'waiting_approval'
  }
  return 'in_progress'
}

const productionWatchTerminalPhases = new Set([
  'completed',
  'failed',
  'waiting_approval',
])

const watchProductionRun = async ({
  ctx,
  orderId,
}: {
  ctx: CommandContext
  orderId: string
}): Promise<unknown> => {
  const intervalMs = parsePositiveIntegerFlag(ctx.flags, 'interval-ms', 5000)
  const timeoutMs = parsePositiveIntegerFlag(ctx.flags, 'timeout-ms', 1800000)
  const startedAt = Date.now()
  let lastPhase: string | undefined

  while (Date.now() - startedAt <= timeoutMs) {
    const status = await ctx.client.v1.getProductionStatus(orderId)
    const phase = deriveRunPhase(status)
    if (phase !== lastPhase) {
      stderr.write(`[watch] order=${orderId} phase=${phase}\n`)
      lastPhase = phase
    }
    if (productionWatchTerminalPhases.has(phase)) {
      return status
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }

  throw new Error(
    `Watch timeout: order=${orderId} did not reach a terminal phase within ${timeoutMs}ms`,
  )
}

const pollProductionStatus = async ({
  ctx,
  orderId,
  terminalStatuses,
}: {
  ctx: CommandContext
  orderId: string
  terminalStatuses: Set<string>
}): Promise<unknown> => {
  const intervalMs = parsePositiveIntegerFlag(ctx.flags, 'interval-ms', 5000)
  const timeoutMs = parsePositiveIntegerFlag(ctx.flags, 'timeout-ms', 900000)
  const deadline = Date.now() + timeoutMs
  const timeout = () =>
    new CliExecutionError(
      `Wait timed out for order ${orderId}; server execution continues.`,
      3,
      activeExecution.operationId,
      activeExecution.execution,
      activeExecution.runId,
    )
  while (Date.now() < deadline) {
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
    let status
    try {
      status = await ctx.client.v1.getProductionStatus(orderId, {signal})
    } catch (error) {
      if (signal.aborted) throw timeout()
      throw error
    }
    const orderStatus = status.order.status
    stderr.write(`[poll] order=${orderId} status=${orderStatus}\n`)
    if (terminalStatuses.has(orderStatus)) return status
    await new Promise(resolve =>
      setTimeout(
        resolve,
        Math.min(intervalMs, Math.max(0, deadline - Date.now())),
      ),
    )
  }
  throw timeout()
}

const pollIfRequested = async ({
  ctx,
  jobId,
  apiVersion = 'v2',
}: {
  ctx: CommandContext
  jobId: string
  apiVersion?: 'v1' | 'v2'
}): Promise<Job | undefined> => {
  if (!hasFlag(ctx.flags, 'wait')) {
    return undefined
  }
  const intervalMs = parsePositiveIntegerFlag(ctx.flags, 'interval-ms', 5000)
  const timeoutMs = parsePositiveIntegerFlag(ctx.flags, 'timeout-ms', 900000)
  const pollJob =
    apiVersion === 'v1' ? ctx.client.v1.pollJob : ctx.client.v2.pollJob
  return pollJob(jobId, {
    intervalMs,
    timeoutMs,
    onPoll: job => {
      stderr.write(`[poll] job=${job.id} status=${job.status}\n`)
    },
  })
}

const requirePositional = (
  positionals: string[],
  index: number,
  label: string,
): string => {
  const value = positionals[index]
  if (value == null || value.trim().length === 0) {
    throw new Error(`Missing required argument: ${label}`)
  }
  return value
}

const commandSource = async (
  subcommand: string | undefined,
  ctx: CommandContext,
): Promise<void> => {
  if (subcommand !== 'create') {
    throw new Error('Unknown source command. Use "source create".')
  }

  const mediaType = parseMediaType(requireFlag(ctx.flags, 'media-type'))
  const source = await resolveSource({
    flags: ctx.flags,
    client: ctx.client,
    fileMediaType: mediaType,
    preferUploadId: true,
  })

  if (!source) throw new Error(missingSourceMessage)
  if (source.uploadId != null) {
    print({source, uploadId: source.uploadId, mediaType})
    return
  }
  if (source.url != null) {
    print({source, url: source.url, mediaType})
    return
  }

  if (source.resourceId != null) {
    print({source, resourceId: source.resourceId, mediaType})
    return
  }

  print({source, fileRef: source.fileRef, mediaType})
}

const commandModels = async (
  subcommand: string | undefined,
  positionals: string[],
  ctx: CommandContext,
): Promise<void> => {
  if (subcommand === 'list') {
    const domain = getFlag(ctx.flags, 'domain')
    const limit =
      getFlag(ctx.flags, 'limit') == null
        ? undefined
        : parsePositiveIntegerFlag(ctx.flags, 'limit', 1)
    const models = (await ctx.client.v2.listModels())
      .filter(model => domain == null || model.domain === domain)
      .slice(0, limit)
    print({
      models: hasFlag(ctx.flags, 'ids-only')
        ? models.map(model => model.id)
        : models,
    })
    return
  }

  if (subcommand === 'get') {
    const modelId = requirePositional(positionals, 2, 'model-id')
    print({model: await ctx.client.v2.getModel(modelId)})
    return
  }

  throw new Error('Unknown models command. Use "models list" or "models get".')
}

const workspaceAuth = async (flags: Flags, allowPersonal = false) => {
  const configPath = getConfigPath(flags)
  const config = await readAuthConfig(configPath)
  const explicitProfile = hasFlag(flags, 'profile') ? requireFlag(flags, 'profile') : undefined
  const profile = explicitProfile ?? config.defaultProfile ?? defaultProfileName
  const stored = config.profiles?.[profile]
  const preferredKey = preferredApiKey(flags, stored)
  if (allowPersonal && (canDiscoverPersonalKey(preferredKey) || (preferredKey === stored?.apiKey && isPersonalProfile(stored)))) {
    const auth = await resolveAuth(flags)
    auth.authentication = personalProfileAuthentication(auth.apiKey, auth.baseUrl, stored)
    const knownPersonal = isPersonalProfile(auth)
    const account = knownPersonal ? undefined : await personalAccount(auth)
    if (knownPersonal || account) {
      if (account) await rememberPersonalProfile(auth, configPath, config, account.userId)
      return {
        configPath, config, profile, accessToken: auth.apiKey,
        workspaceMfaToken: undefined, baseUrl: auth.baseUrl,
        selectedWorkspaceId: auth.workspaceId, personal: true,
        client: createWorkspaceClient({accessToken: auth.apiKey, baseUrl: auth.baseUrl, workspaceId: auth.workspaceId}),
      }
    }
  }
  const environmentToken = explicitProfile ? undefined : env.ASSETHUB_ACCESS_TOKEN?.trim()
  const accessToken = environmentToken || stored?.accessToken
  if (!accessToken)
    throw new Error(
      'Workspace management requires user authentication: auth login --access-token-stdin or ASSETHUB_ACCESS_TOKEN',
    )
  const baseUrl =
    getFlag(flags, 'base-url') ??
    (explicitProfile ? stored?.baseUrl : env.ASSETHUB_API_BASE_URL ?? stored?.baseUrl) ??
    defaultBaseUrl
  if (
    !environmentToken &&
    stored &&
    new URL(baseUrl).origin !== new URL(stored.baseUrl).origin
  )
    throw new Error(
      'Saved user authentication belongs to another API origin; log in for this origin',
    )
  const workspaceMfaToken =
    (!explicitProfile && env.ASSETHUB_WORKSPACE_MFA?.trim()) ||
    (stored && new URL(baseUrl).origin === new URL(stored.baseUrl).origin
      ? stored.workspaceMfaToken
      : undefined)
  return {
    configPath,
    config,
    profile,
    accessToken,
    workspaceMfaToken,
    baseUrl,
    selectedWorkspaceId: environmentToken ? undefined : stored?.workspaceId,
    personal: false,
    client: createWorkspaceClient({accessToken, workspaceMfaToken, baseUrl}),
  }
}

const commandWorkspace = async (
  subcommand: string | undefined,
  positionals: string[],
  flags: Flags,
) => {
  const suppliedKey = hasFlag(flags, 'api-key')
    ? requireFlag(flags, 'api-key')
    : hasFlag(flags, 'profile')
      ? undefined
      : env.ASSETHUB_API_KEY?.trim()
  const auth = await workspaceAuth(flags, ['list', 'get', 'use'].includes(subcommand ?? ''))
  if (['members', 'invite', 'set-role', 'remove-member'].includes(subcommand ?? '')) {
    let workspaceId = getFlag(flags, 'workspace') ?? auth.selectedWorkspaceId
    if (!workspaceId) workspaceId = (await auth.client.list()).workspaces.find(item => item.active)?.id
    if (!workspaceId) throw new Error('Specify --workspace <id> or select one with workspace use <id>')
    if (subcommand === 'members') {
      print(await auth.client.listMembers(workspaceId))
      return
    }
    const role = subcommand === 'invite' ? getFlag(flags, 'role') ?? 'user' : subcommand === 'set-role' ? requireFlag(flags, 'role') : undefined
    if (role !== undefined && role !== 'user' && role !== 'admin') throw new Error('--role must be user or admin')
    stderr.write(`[workspace] ${subcommand} in ${workspaceId}…\n`)
    if (subcommand === 'invite') print(await auth.client.inviteMember(workspaceId, {email: requireFlag(flags, 'email'), role: role as 'user' | 'admin', ...(hasFlag(flags, 'resend') ? {resend: true} : {})}))
    else if (subcommand === 'set-role') print(await auth.client.setMemberRole(workspaceId, {userId: requirePositional(positionals, 2, 'user-id'), role: role as 'user' | 'admin'}))
    else print(await auth.client.removeMember(workspaceId, requirePositional(positionals, 2, 'user-id')))
    return
  }
  if (subcommand === 'list') {
    print(await auth.client.list({
      query: getFlag(flags, 'query'),
      cursor: getFlag(flags, 'cursor'),
      limit: hasFlag(flags, 'limit') ? parsePositiveIntegerFlag(flags, 'limit', 100) : undefined,
    }))
    return
  }
  if (subcommand === 'get') {
    if (auth.personal && auth.selectedWorkspaceId) {
      const selected = await auth.client.select(auth.selectedWorkspaceId)
      if (!selected.workspace) throw new Error('Workspace API returned no selected workspace')
      print(selected.workspace)
      return
    }
    const account = await auth.client.list()
    const selected = auth.selectedWorkspaceId
    const workspace = account.workspaces.find(item =>
      selected ? item.id === selected : item.active,
    )
    if (!workspace)
      throw new Error('No workspace selected; use workspace use <id>')
    print(workspace)
    return
  }
  if (subcommand === 'create') {
    const name = requireFlag(flags, 'name')
    const operationId = getFlag(flags, 'operation-id') ?? randomUUID()
    activeExecution.operationId = operationId
    // The caller can replay the printed identity after an uncertain HTTP response.
    stderr.write(`[workspace] operation ${operationId}\n`)
    print({
      ...(await auth.client.create({name}, {idempotencyKey: operationId})),
      operationId,
    })
    return
  }
  if (subcommand !== 'use') throw new Error('Use workspace list|get|create|use')
  const workspaceId = requirePositional(positionals, 2, 'workspace-id')
  const selected = await auth.client.select(workspaceId)
  if (selected.workspaceId !== workspaceId)
    throw new Error('Workspace API returned an invalid selection scope')
  if (
    selected.mfa.status === 'setup_required' ||
    selected.mfa.status === 'verify_required'
  )
    throw new Error(
      'Workspace requires MFA. Complete verification in AssetHub, then provide the signed ah_workspace_mfa cookie through ASSETHUB_WORKSPACE_MFA together with your user access token',
    )
  const account = await auth.client.list()
  const workspace = selected.workspace ?? account.workspaces.find(item => item.id === workspaceId)
  if (!workspace)
    throw new Error('Workspace is not available to this authenticated user')
  const profiles = auth.config.profiles ?? {}
  if (auth.personal) {
    if (account.authentication !== 'personal') throw new Error('Workspace API did not verify personal authentication')
    profiles[auth.profile] = {
      apiKey: auth.accessToken,
      authentication: 'personal',
      userId: account.userId,
      workspaceId,
      baseUrl: auth.baseUrl,
      updatedAt: new Date().toISOString(),
    }
    await writeAuthConfig(auth.configPath, {...auth.config, defaultProfile: auth.profile, profiles})
    print({workspaceId, workspace, profile: auth.profile, selected: true, baseUrl: auth.baseUrl})
    return
  }
  const cached = Object.entries(profiles).find(
    ([, entry]) =>
      entry.userId === account.userId &&
      entry.workspaceId === workspaceId &&
      new URL(entry.baseUrl).origin === new URL(auth.baseUrl).origin &&
      entry.apiKey && !isPersonalProfile(entry),
  )
  let apiKey: string | undefined
  for (const candidate of new Set([cached?.[1].apiKey, suppliedKey])) {
    if (!candidate) continue
    try {
      const capabilities = await createAssetHubClient({
        apiKey: candidate,
        baseUrl: auth.baseUrl,
      }).v2.getCapabilities()
      if (capabilities.ownerId === workspaceId) {
        apiKey = candidate
        break
      }
      if (candidate === cached?.[1].apiKey)
        throw new Error(
          'Saved API key does not belong to the selected workspace',
        )
    } catch (error) {
      if (!(error instanceof AssetHubApiError) || error.status !== 401)
        throw error
    }
  }
  if (!apiKey) {
    const issued = await auth.client.createApiKey(workspaceId, {
      name: 'AssetHub CLI',
    })
    if (issued.workspaceId !== workspaceId || !issued.key)
      throw new Error('Workspace API returned an invalid key scope')
    apiKey = issued.key
  }
  const profile = cached?.[0] ?? `workspace-${account.userId}-${workspaceId}`
  profiles[profile] = {
    apiKey,
    accessToken: auth.accessToken,
    workspaceMfaToken: auth.workspaceMfaToken,
    userId: account.userId,
    workspaceId,
    baseUrl: auth.baseUrl,
    updatedAt: new Date().toISOString(),
  }
  await writeAuthConfig(auth.configPath, {
    ...auth.config,
    defaultProfile: profile,
    profiles,
  })
  print({
    workspaceId,
    workspace,
    profile,
    selected: true,
    baseUrl: auth.baseUrl,
  })
}

const commandAuth = async (
  subcommand: string | undefined,
  flags: Flags,
): Promise<void> => {
  const profile = getProfileName(flags)
  const configPath = getConfigPath(flags)

  if (subcommand === 'login') {
    if (hasFlag(flags, 'access-token-stdin')) {
      if (hasFlag(flags, 'api-key-stdin') || getFlag(flags, 'api-key'))
        throw new Error('Choose user access-token login or API-key login')
      const accessToken = (await readStdin()).trim()
      const baseUrl =
        getFlag(flags, 'base-url') ??
        env.ASSETHUB_API_BASE_URL ??
        defaultBaseUrl
      const workspaceMfaToken = env.ASSETHUB_WORKSPACE_MFA?.trim() || undefined
      const account = await createWorkspaceClient({
        accessToken,
        workspaceMfaToken,
        baseUrl,
      }).list()
      const config = await readAuthConfig(configPath)
      await writeAuthConfig(configPath, {
        ...config,
        defaultProfile: profile,
        profiles: {
          ...config.profiles,
          [profile]: {
            accessToken,
            workspaceMfaToken,
            baseUrl,
            userId: account.userId,
            updatedAt: new Date().toISOString(),
          },
        },
      })
      print({
        success: true,
        authentication: 'user',
        userId: account.userId,
        profile,
        baseUrl,
        configPath,
        verified: true,
      })
      return
    }
    const apiKey = hasFlag(flags, 'api-key-stdin')
      ? (await readStdin()).trim()
      : (getFlag(flags, 'api-key') ?? env.ASSETHUB_API_KEY ?? '').trim()
    if (apiKey.length === 0) {
      throw new Error(
        'API key is empty. Pass --api-key, use --api-key-stdin, or set ASSETHUB_API_KEY.',
      )
    }

    const baseUrl =
      getFlag(flags, 'base-url') ?? env.ASSETHUB_API_BASE_URL ?? defaultBaseUrl
    const config = await readAuthConfig(configPath)
    const authentication = personalProfileAuthentication(apiKey, baseUrl, config.profiles?.[profile])
    const account = await personalAccount({apiKey, baseUrl, authentication})
    const personal = account !== undefined
    if (!personal && !hasFlag(flags, 'skip-verify')) {
      const client = createAssetHubClient({apiKey, baseUrl})
      await client.v2.listModels()
    }

    const profiles = config.profiles ?? {}
    profiles[profile] = {
      apiKey,
      baseUrl,
      ...(account ? {authentication: 'personal' as const, userId: account.userId} : {}),
      updatedAt: new Date().toISOString(),
    }
    await writeAuthConfig(configPath, {
      ...config,
      defaultProfile: profile,
      profiles,
    })

    print({
      success: true,
      profile,
      baseUrl,
      configPath,
      verified: personal || !hasFlag(flags, 'skip-verify'),
      ...(account ? {authentication: 'personal', userId: account.userId} : {}),
    })
    return
  }

  if (subcommand === 'status') {
    const config = await readAuthConfig(configPath)
    const current =
      config.profiles?.[
        getFlag(flags, 'profile') ?? config.defaultProfile ?? profile
      ]
    let apiAuth: ResolvedAuth | undefined
    const preferredKey = preferredApiKey(flags, current)
    if (canDiscoverPersonalKey(preferredKey) || (preferredKey === current?.apiKey && isPersonalProfile(current))) {
      apiAuth = await resolveAuth(flags)
      apiAuth.authentication = personalProfileAuthentication(apiAuth.apiKey, apiAuth.baseUrl, current)
      const account = await personalAccount(apiAuth)
      if (account) {
        if (apiAuth.workspaceId) await createAssetHubClient(apiAuth).v2.getCapabilities()
        await rememberPersonalProfile(apiAuth, configPath, config, account.userId)
        print({authenticated: true, authentication: 'personal', userId: account.userId, workspaceId: apiAuth.workspaceId,
          profile: apiAuth.profile, source: apiAuth.source, baseUrl: apiAuth.baseUrl})
        return
      }
    }
    if (
      !hasFlag(flags, 'api-key') &&
      ((!hasFlag(flags, 'profile') && env.ASSETHUB_ACCESS_TOKEN?.trim()) ||
        (current?.accessToken && !current.apiKey))
    ) {
      const auth = await workspaceAuth(flags)
      const account = await auth.client.list()
      print({
        authenticated: true,
        authentication: 'user',
        userId: account.userId,
        workspaceCount: account.workspaces.length,
        profile: auth.profile,
        baseUrl: auth.baseUrl,
      })
      return
    }
    const auth = apiAuth ?? await resolveAuth(flags)
    const client = createAssetHubClient({
      apiKey: auth.apiKey,
      baseUrl: auth.baseUrl,
      workspaceId: auth.workspaceId,
    })
    const models = await client.v2.listModels()
    print({
      authenticated: true,
      profile: auth.profile,
      source: auth.source,
      baseUrl: auth.baseUrl,
      modelCount: models.length,
    })
    return
  }

  if (subcommand === 'logout') {
    const config = await readAuthConfig(configPath)
    const selectedProfile = getFlag(flags, 'profile') ?? config.defaultProfile ?? profile
    const profiles = config.profiles ?? {}
    const existed = profiles[selectedProfile] != null
    delete profiles[selectedProfile]
    await writeAuthConfig(configPath, {
      defaultProfile:
        config.defaultProfile === selectedProfile ? undefined : config.defaultProfile,
      profiles,
    })
    print({success: true, profile: selectedProfile, removed: existed, configPath})
    return
  }

  throw new Error(
    'Unknown auth command. Use "auth login", "auth status", or "auth logout".',
  )
}

const commandFiles = async (
  subcommand: string | undefined,
  positionals: string[],
  ctx: CommandContext,
): Promise<void> => {
  const mediaType = parseMediaType(requireFlag(ctx.flags, 'media-type'))

  if (subcommand === 'import') {
    const url = requirePositional(positionals, 2, 'url')
    print(await ctx.client.v2.importFile({url, mediaType}))
    return
  }

  if (subcommand === 'upload') {
    const filePath = requirePositional(positionals, 2, 'file')
    print(
      await ctx.client.v2.uploadFile({
        file: await readBlob(filePath),
        fileName: basename(filePath),
        mediaType,
      }),
    )
    return
  }

  throw new Error(
    'Unknown files command. Use "files import" or "files upload".',
  )
}

const stateOptions = (ctx: CommandContext) => ({
  client: ctx.client,
  cwd: process.cwd(),
  stateDir:
    env.ASSETHUB_CLI_STATE_DIR ??
    join(dirname(getConfigPath(ctx.flags)), 'state'),
})
const selectedCanvasId = (flags: Flags): number | undefined =>
  getFlag(flags, 'canvas') == null
    ? undefined
    : parsePositiveIntegerFlag(flags, 'canvas', 1)
const executionOptions = (flags: Flags) => ({
  operationId: getFlag(flags, 'operation-id'),
  parentRunId:
    getFlag(flags, 'derived-from-run') ?? getFlag(flags, 'parent-run'),
  agent: getFlag(flags, 'agent')
    ? {
        name: getFlag(flags, 'agent')!,
        sessionId: getFlag(flags, 'agent-session'),
      }
    : undefined,
})
const watchOptions = (flags: Flags) => ({
  intervalMs: parsePositiveIntegerFlag(flags, 'interval-ms', 5000),
  timeoutMs: parsePositiveIntegerFlag(flags, 'timeout-ms', 900000),
  onProgress: (run: CanvasExecution) =>
    stderr.write(`[run] ${run.runId} ${run.status}\n`),
})
const readJsonArgument = async (
  value: string,
  flag: string,
): Promise<Record<string, unknown>> => {
  const text =
    value === '@-'
      ? await readStdin()
      : value.startsWith('@')
        ? await readFile(resolve(value.slice(1)), 'utf8')
        : value
  const parsed = parseJsonValue(text, flag)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${flag} must contain a JSON object`)
  return parsed as Record<string, unknown>
}
const recordedSource = async (
  ctx: CommandContext,
  source?: Source,
): Promise<Source | undefined> => {
  if (!source) return undefined
  if (source.url) {
    const imported = await ctx.client.v2.importFile({
      url: source.url,
      mediaType: 'image',
    })
    if (!imported.uploadId)
      throw new Error('Server did not return a durable upload ID')
    return {uploadId: imported.uploadId}
  }
  if (source.fileRef)
    throw new Error(
      'Canvas history requires --file, --source-id, --source-url or an uploadId; raw fileRef is unsupported',
    )
  return source
}
const graphSourceInput = async (
  ctx: CommandContext,
  canvasId: number,
): Promise<
  | {source: Source; graphSource: NonNullable<ExecutionContext['graphSource']>}
  | undefined
> => {
  const fromNode = getFlag(ctx.flags, 'from-node')
  if (!fromNode) {
    if (getFlag(ctx.flags, 'graph-revision'))
      throw new Error('--graph-revision requires --from-node')
    return undefined
  }
  if (sourceInputCount(ctx.flags) || getFlag(ctx.flags, 'input-json'))
    throw new Error(
      '--from-node cannot be combined with another source or --input-json',
    )
  const separator = fromNode.indexOf('/')
  if (separator < 1) throw new Error('--from-node must be <graphId>/<nodeId>')
  const graphId = fromNode.slice(0, separator),
    nodeId = fromNode.slice(separator + 1)
  const revision = requireFlag(ctx.flags, 'graph-revision')
  const graph = await ctx.client.v2.getCanvasGraph(canvasId)
  if (graph.graphId !== graphId || graph.revision !== revision)
    throw new Error(
      'Graph revision changed or belongs to another canvas; read graph show again',
    )
  const node = graph.nodes.find(item => item.id === nodeId)
  const assetId = node?.metadata.assetId
  if (typeof assetId !== 'string')
    throw new Error('Graph node has no source asset in this graph projection')
  return {
    source: {resourceId: assetId},
    graphSource: {graphId, nodeId, revision},
  }
}
const executionExitCode = (execution: CanvasExecution): number =>
  ['failed', 'partial', 'cancelled'].includes(execution.status)
    ? 1
    : execution.status === 'needs_review' ||
        execution.history.status !== 'recorded'
      ? 3
      : 0
const printRecorded = async (
  ctx: CommandContext,
  queued: {execution: CanvasExecution},
) => {
  const execution = hasFlag(ctx.flags, 'wait')
    ? await waitForExecution(
        ctx.client,
        queued.execution.runId,
        watchOptions(ctx.flags),
      )
    : queued.execution
  const job =
    hasFlag(ctx.flags, 'wait') && execution.jobIds[0]
      ? await ctx.client.v2.getJob(execution.jobIds[0])
      : undefined
  const downloads = await maybeDownloadUrls(ctx.flags, execution.outputs)
  print({
    queued: execution.operation.startsWith('production.')
      ? sanitizeProductionOutput(queued)
      : queued,
    job,
    execution,
    apiVersion: execution.operation.startsWith('production.') ? 'v1' : 'v2',
    ...(downloads ? {downloads} : {}),
  })
  process.exitCode = executionExitCode(execution)
}

const canvasNodeFlag = (flags: Flags): string | undefined => {
  if (!hasFlag(flags, 'node')) return undefined
  const nodeId = requireFlag(flags, 'node')
  if (!nodeId.startsWith('shape:') || nodeId.length <= 6)
    throw new Error('--node must be a native shape:<id> from canvas nodes')
  if (
    sourceInputCount(flags) ||
    [
      'input-json',
      'upload-id',
      'from-node',
      'graph-revision',
      'from-run',
      'part',
      'reference',
      'transforms-json',
    ].some(name => hasFlag(flags, name))
  )
    throw new Error(
      '--node cannot be combined with explicit sources, parts, reference, input JSON, or another node/run selector',
    )
  return nodeId
}

const printNodeMeshBatch = async (
  ctx: CommandContext,
  batch: NodeMeshBatchResult,
) => {
  const executions = [...batch.executions]
  if (hasFlag(ctx.flags, 'wait')) {
    try {
      for (let i = 0; i < executions.length; i++)
        executions[i] = await waitForExecution(
          ctx.client,
          executions[i].runId,
          watchOptions(ctx.flags),
        )
    } catch (error) {
      if (!(error instanceof CliExecutionError)) throw error
      throw new CliExecutionError(
        error.message,
        error.exitCode,
        batch.operationId,
        error.execution,
        error.runId,
      )
    }
  }
  const downloads = await maybeDownloadUrls(
    ctx.flags,
    executions.flatMap(execution => execution.outputs),
  )
  print({...batch, executions, ...(downloads ? {downloads} : {})})
  process.exitCode = Math.max(0, ...executions.map(executionExitCode))
}

const commandNodeMesh = async (ctx: CommandContext, nodeId: string) => {
  const body: Record<string, unknown> = {}
  const modelId = getFlag(ctx.flags, 'model-id')
  if (modelId) body.modelId = modelId
  const name = getFlag(ctx.flags, 'name')
  if (name) body.name = name
  if (hasFlag(ctx.flags, 'face-limit'))
    body.faceLimit = parsePositiveIntegerFlag(ctx.flags, 'face-limit', 1)
  if (hasFlag(ctx.flags, 'low-poly'))
    body.isLowPoly = parseBooleanFlag(ctx.flags, 'low-poly')
  if (hasFlag(ctx.flags, 'params-json')) {
    const params = await readJsonArgument(
      requireFlag(ctx.flags, 'params-json'),
      '--params-json',
    )
    if (
      Object.values(params).some(
        value =>
          typeof value !== 'string' &&
          typeof value !== 'boolean' &&
          !(typeof value === 'number' && Number.isFinite(value)),
      )
    )
      throw new Error(
        '--params-json values must be strings, booleans, or finite numbers',
      )
    body.params = params
  }
  const operationId = getFlag(ctx.flags, 'operation-id')
  const canvasId = selectedCanvasId(ctx.flags)
  const resumeOptions = {
    ...stateOptions(ctx),
    expectedCanvasId: canvasId,
    expectedCanvasNodeId: nodeId,
    expectedBody: body,
  }
  if (operationId) {
    const batch = await resumeNodeMeshBatch({...resumeOptions, operationId})
    if (batch) {
      await printNodeMeshBatch(ctx, batch)
      return
    }
    if (await hasRecordedOperation(resumeOptions.stateDir, operationId)) {
      await printRecorded(
        ctx,
        await resumeRecorded({
          ...resumeOptions,
          operationId,
          expectedOperation: 'mesh.generate',
        }),
      )
      return
    }
  }
  const session = await openExecutionSession({
    ...stateOptions(ctx),
    canvasId,
    operation: 'mesh.generate',
    create: false,
  })
  const {items} = await ctx.client.v2.listCanvasNodes(session.canvas.id)
  const target = items.find(item => item.nodeId === nodeId)
  if (!target)
    throw new Error('Canvas node is unavailable; read canvas nodes again')
  const finishedOrBusy = (status?: string) =>
    ['complete', 'completed', 'generating'].includes(status ?? '')
  if (target.type === 'production-3d') {
    if (!target.actions.includes('mesh.generate'))
      throw new Error('Mesh generation is unavailable for this node')
    const children = items.filter(
      item =>
        item.sourceNodeId === nodeId &&
        ['mesh-gen', 'preview-asset', 'part-group'].includes(item.type),
    )
    if (!children.length)
      throw new Error('Production node has no saved part nodes to generate')
    const pending = children.filter(
      item =>
        item.actions.includes('mesh.generate') &&
        !finishedOrBusy(item.meshStatus),
    )
    const batchId = operationId ?? randomUUID()
    stderr.write(`[nodes] batch ${batchId}\n`)
    await printNodeMeshBatch(
      ctx,
      await executeNodeMeshBatch(session, {
        ...executionOptions(ctx.flags),
        operationId: batchId,
        nodeId,
        body,
        children: pending.map(item => item.nodeId),
        skipped: children
          .filter(item => !pending.includes(item))
          .map(({nodeId, meshStatus}) => ({nodeId, meshStatus})),
      }),
    )
    return
  }
  if (!['mesh-gen', 'preview-asset', 'part-group'].includes(target.type))
    throw new Error('This canvas node cannot generate a mesh')
  if (
    target.meshStatus === 'generating' ||
    (target.type !== 'mesh-gen' && finishedOrBusy(target.meshStatus))
  ) {
    print({nodeId, skipped: true, meshStatus: target.meshStatus})
    return
  }
  if (!target.actions.includes('mesh.generate'))
    throw new Error('Mesh generation is unavailable for this node')
  await printRecorded(
    ctx,
    await executeRecorded(
      session,
      'mesh.generate',
      body as MeshGenerationRequest,
      {
        ...executionOptions(ctx.flags),
        canvasNode: {nodeId},
      },
    ),
  )
}

const commandImage = async (
  subcommand: string | undefined,
  ctx: CommandContext,
): Promise<void> => {
  if (subcommand !== 'generate')
    throw new Error('Unknown image command. Use "image generate".')
  if (
    getFlag(ctx.flags, 'api-version') &&
    getFlag(ctx.flags, 'api-version') !== 'v2'
  )
    throw new Error('Canvas generation requires --api-version v2')
  const inputJson = getFlag(ctx.flags, 'input-json')
  const input = inputJson
    ? await readJsonArgument(inputJson, '--input-json')
    : {
        prompt: requireFlag(ctx.flags, 'prompt'),
        modelId: getFlag(ctx.flags, 'model-id') ?? defaultImageModelId,
        batchSize: parsePositiveIntegerFlag(ctx.flags, 'batch-size', 1),
        negativePrompt: getFlag(ctx.flags, 'negative-prompt'),
        seed:
          getFlag(ctx.flags, 'seed') == null
            ? undefined
            : parsePositiveIntegerFlag(ctx.flags, 'seed', 1),
        steps:
          getFlag(ctx.flags, 'steps') == null
            ? undefined
            : parsePositiveIntegerFlag(ctx.flags, 'steps', 1),
        cfgScale:
          getFlag(ctx.flags, 'cfg-scale') == null
            ? undefined
            : Number(getFlag(ctx.flags, 'cfg-scale')),
      }
  if (typeof input.prompt !== 'string' || !input.prompt.trim())
    throw new Error('Image prompt is required')
  const contextCanvas =
    getFlag(ctx.flags, 'context') == null
      ? undefined
      : parsePositiveIntegerFlag(ctx.flags, 'context', 1)
  const explicitCanvas = selectedCanvasId(ctx.flags)
  if (
    contextCanvas != null &&
    explicitCanvas != null &&
    contextCanvas !== explicitCanvas
  )
    throw new Error('--context must match --canvas')
  const session = await openExecutionSession({
    ...stateOptions(ctx),
    canvasId: explicitCanvas ?? contextCanvas,
    operation: 'image.generate',
  })
  if (contextCanvas != null) {
    const saved = await ctx.client.v2.getCanvasContext(contextCanvas)
    input.projectContext = {
      canvasId: contextCanvas,
      version:
        getFlag(ctx.flags, 'context-version') == null
          ? saved.projectContext.version
          : parsePositiveIntegerFlag(ctx.flags, 'context-version', 1),
      ...(getFlagValues(ctx.flags, 'context-source').length
        ? {sourceKeys: getFlagValues(ctx.flags, 'context-source')}
        : {}),
    }
  }
  const moodboardRevisionId = getFlag(ctx.flags, 'moodboard-revision')
  if (moodboardRevisionId) input.moodboardRevisionId = moodboardRevisionId
  const graphInput = await graphSourceInput(ctx, session.canvas.id)
  const source =
    graphInput?.source ??
    (await recordedSource(
      ctx,
      inputJson
        ? (input.source as Source | undefined)
        : await resolveSource({
            flags: ctx.flags,
            client: ctx.client,
            fileMediaType: 'image',
            preferUploadId: true,
          }),
    ))
  if (source) input.source = source
  if (Array.isArray(input.sources))
    input.sources = await Promise.all(
      input.sources.map(source => recordedSource(ctx, source as Source)),
    )
  await printRecorded(
    ctx,
    await executeRecorded(
      session,
      'image.generate',
      input as ImageGenerationRequest,
      {...executionOptions(ctx.flags), graphSource: graphInput?.graphSource},
    ),
  )
}

const meshRefinementModes = [
  'standard',
  'thorough',
  'placement',
  'workshop',
  'blender',
] as const satisfies readonly MeshRefinementMode[]

const refinementTransforms = (value: unknown, flag: string) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${flag} must be an object keyed by part asset ID`)
  const result: Record<string, MeshTransform> = {}
  for (const [assetId, transform] of Object.entries(value)) {
    if (
      !Array.isArray(transform) ||
      transform.length !== 10 ||
      transform.some(entry => typeof entry !== 'number' || !Number.isFinite(entry))
    )
      throw new Error(`${flag} must contain ten finite numbers for ${assetId}`)
    result[assetId] = transform as MeshTransform
  }
  if (Object.keys(result).length === 0)
    throw new Error(`${flag} must contain at least one part transform`)
  return result
}

const refinementTransform = (value: unknown, flag: string) => {
  if (
    !Array.isArray(value) ||
    value.length !== 10 ||
    value.some(entry => typeof entry !== 'number' || !Number.isFinite(entry))
  )
    throw new Error(`${flag} must contain ten finite numbers`)
  return value as MeshTransform
}

const refinementModeInfo = (
  capabilities: MeshRefinementCapabilities,
  mode: MeshRefinementMode,
) => {
  const info = capabilities.modes.find(item => item.id === mode)
  if (!info) throw new Error(`Unknown refinement mode: ${mode}`)
  if (!info.available)
    throw new Error(
      `Refinement mode ${mode} is unavailable${info.reason ? `: ${info.reason}` : ''}`,
    )
  return info
}

/** Reuse the frozen sources and latest editable scene, never replay server-only receipt fields. */
const composerInputFromRun = (
  previous: CanvasExecution,
  operation: 'mesh.compose' | 'mesh.refine',
): Record<string, unknown> => {
  const source =
    previous.resolvedInput ?? previous.input ?? previous.requestedInput ?? {}
  const fields =
    operation === 'mesh.compose'
      ? [
          'fullBodyImageAssetId',
          'agentVersion',
          'agentRuntime',
          'mode',
          'targetCharacterHeightM',
          'projectName',
          'decimateRatio',
          'quickRunId',
          'quickScene',
        ]
      : ['fullBodyImageAssetId', 'agentRuntime', 'mode', 'instruction', 'maxRounds']
  const input: Record<string, unknown> = Object.fromEntries(
    fields
      .filter(key => source[key] !== undefined)
      .map(key => [key, source[key]]),
  )
  const parts = previous.composition?.parts ?? source.parts
  const partFields =
    operation === 'mesh.compose'
      ? ['assetId', 'name', 'canonicalKey', 'partImageAssetId', 'partTaskId']
      : [
          'assetId',
          'name',
          'canonicalKey',
          'volumeCentroid',
          'sourceAssetId',
          'transform',
        ]
  input.parts = Array.isArray(parts)
    ? parts.map(part =>
        part && typeof part === 'object'
          ? Object.fromEntries(
              Object.entries(part).filter(([key]) => partFields.includes(key)),
            )
          : part,
      )
    : parts
  const transforms = previous.composition?.transforms ?? source.transforms
  if (transforms != null) input.transforms = transforms
  if (operation === 'mesh.refine') {
    const referenceTransform =
      previous.composition?.referenceTransform ?? source.referenceTransform
    if (referenceTransform != null)
      input.referenceTransform = referenceTransform
    // Compose modes are not refinement modes; preserve a prior refinement's mode only.
    if (previous.operation !== 'mesh.refine') delete input.mode
  }
  return input
}

const commandComposerRefine = async (ctx: CommandContext) => {
  const capabilities = await ctx.client.v2.getMeshRefinementModes()
  if (hasFlag(ctx.flags, 'list-modes')) {
    print(capabilities)
    return
  }
  const fromRun = getFlag(ctx.flags, 'from-run')
  const json = getFlag(ctx.flags, 'input-json')
  const parts = getFlagValues(ctx.flags, 'part')
  const reference = getFlag(ctx.flags, 'reference')
  if (
    (fromRun && (json || parts.length || reference)) ||
    (json && (parts.length || reference))
  )
    throw new Error(
      'Choose --from-run, --input-json, or --part with --reference',
    )
  const previous = fromRun ? await ctx.client.v2.getRun(fromRun) : undefined
  if (
    previous &&
    previous.operation !== 'mesh.compose' &&
    previous.operation !== 'mesh.refine'
  )
    throw new Error('--from-run must identify a mesh.compose or mesh.refine execution')
  if (previous && ['queued', 'running'].includes(previous.status))
    throw new Error(
      '--from-run must identify a finished mesh.compose or mesh.refine checkpoint',
    )

  const input = json
    ? await readJsonArgument(json, '--input-json')
    : previous
      ? composerInputFromRun(previous, 'mesh.refine')
      : {
          parts: parts.map(assetId => ({
            assetId: assertFlagHasValue(assetId, '--part <asset-id>'),
          })),
          fullBodyImageAssetId: requireFlag(ctx.flags, 'reference'),
        }
  delete input.executionContext
  if (!Array.isArray(input.parts) || input.parts.length === 0)
    throw new Error('Composer refinement requires parts[]')
  const refinementParts = input.parts.map((part, index) => {
    if (
      !part ||
      typeof part !== 'object' ||
      typeof (part as {assetId?: unknown}).assetId !== 'string' ||
      !(part as {assetId: string}).assetId
    )
      throw new Error(`Composer refinement part ${index + 1} requires assetId`)
    return part as MeshRefineRequest['parts'][number]
  })
  if (
    typeof input.fullBodyImageAssetId !== 'string' ||
    input.fullBodyImageAssetId.length === 0
  )
    throw new Error('Composer refinement requires fullBodyImageAssetId')
  const instruction = getFlag(ctx.flags, 'instruction') ?? input.instruction
  if (typeof instruction !== 'string' || !instruction.trim())
    throw new Error('Composer refinement requires --instruction')
  const mode =
    parseEnumFlag(ctx.flags, 'mode', meshRefinementModes) ??
    (input.mode as MeshRefinementMode | undefined) ??
    capabilities.defaultMode
  if (!meshRefinementModes.includes(mode))
    throw new Error(`--mode must be one of: ${meshRefinementModes.join(', ')}`)
  const modeInfo = refinementModeInfo(capabilities, mode)
  const maxRoundsFlag = getFlag(ctx.flags, 'max-rounds')
  const inputMaxRounds = input.maxRounds
  if (
    inputMaxRounds != null &&
    (typeof inputMaxRounds !== 'number' ||
      !Number.isInteger(inputMaxRounds) ||
      inputMaxRounds <= 0)
  )
    throw new Error('maxRounds must be a positive integer')
  const maxRounds =
    maxRoundsFlag == null
      ? inputMaxRounds
      : parsePositiveIntegerFlag(ctx.flags, 'max-rounds', 1)
  if (maxRounds != null && (!Number.isInteger(maxRounds) || maxRounds <= 0))
    throw new Error('--max-rounds must be a positive integer')
  if (maxRounds != null && maxRounds > modeInfo.maxRounds)
    throw new Error(
      `--max-rounds must be at most ${modeInfo.maxRounds} for ${mode}`,
    )
  const transformsFlag = getFlag(ctx.flags, 'transforms-json')
  const transforms = transformsFlag
    ? refinementTransforms(
        await readJsonArgument(transformsFlag, '--transforms-json'),
        '--transforms-json',
      )
    : refinementTransforms(input.transforms, 'refinement transforms')
  const referenceTransform =
    input.referenceTransform == null
      ? undefined
      : refinementTransform(input.referenceTransform, 'referenceTransform')
  const explicitCanvas = selectedCanvasId(ctx.flags)
  const canvasId = explicitCanvas ?? previous?.canvas.id
  if (previous && canvasId !== previous.canvas.id)
    throw new Error(
      'Refinement must use the original canvas to retain lineage',
    )
  const session = await openExecutionSession({
    ...stateOptions(ctx),
    canvasId,
    operation: 'mesh.refine',
  })
  const body: Omit<MeshRefineRequest, 'executionContext'> = {
    parts: refinementParts,
    fullBodyImageAssetId: input.fullBodyImageAssetId,
    transforms,
    ...(referenceTransform ? {referenceTransform} : {}),
    mode,
    instruction,
    ...(maxRounds != null ? {maxRounds} : {}),
    ...(input.agentRuntime
      ? {agentRuntime: input.agentRuntime as MeshRefineRequest['agentRuntime']}
      : {}),
  }
  await printRecorded(
    ctx,
    await executeRecorded(session, 'mesh.refine', body, {
      ...executionOptions(ctx.flags),
      ...(previous ? {parentRunId: previous.runId} : {}),
    }),
  )
}

const commandComposer = async (
  subcommand: string | undefined,
  ctx: CommandContext,
) => {
  if (subcommand === 'models') {
    print(await ctx.client.v2.getMeshComposers())
    return
  }
  if (subcommand === 'refine') {
    await commandComposerRefine(ctx)
    return
  }
  if (subcommand !== 'run') throw new Error('Use composer models|run')
  const nodeId = canvasNodeFlag(ctx.flags)
  const fromRun = getFlag(ctx.flags, 'from-run')
  const json = getFlag(ctx.flags, 'input-json')
  const parts = getFlagValues(ctx.flags, 'part')
  if (
    (fromRun && (json || parts.length || getFlag(ctx.flags, 'reference'))) ||
    (json && (parts.length || getFlag(ctx.flags, 'reference')))
  )
    throw new Error(
      'Choose --from-run, --input-json, or --part with --reference',
    )
  const previous = fromRun ? await ctx.client.v2.getRun(fromRun) : undefined
  if (previous && previous.operation !== 'mesh.compose')
    throw new Error('--from-run must identify a mesh.compose execution')
  const input: Record<string, unknown> = nodeId
    ? {}
    : previous
      ? composerInputFromRun(previous, 'mesh.compose')
      : json
        ? await readJsonArgument(json, '--input-json')
        : {
            parts: parts.map(assetId => ({
              assetId: assertFlagHasValue(assetId, '--part <asset-id>'),
            })),
            fullBodyImageAssetId: requireFlag(ctx.flags, 'reference'),
          }
  delete input.executionContext
  if (
    !nodeId &&
    (!Array.isArray(input.parts) ||
      !input.parts.length ||
      !input.fullBodyImageAssetId)
  )
    throw new Error('Composer requires parts[] and fullBodyImageAssetId')
  const mode = getFlag(ctx.flags, 'mode')
  if (mode != null && mode !== 'quick' && mode !== 'quality')
    throw new Error('--mode must be quick or quality')
  if (mode) input.mode = mode
  const model = getFlag(ctx.flags, 'model')
  if (model) input.agentVersion = model
  const name = getFlag(ctx.flags, 'name')
  if (name) input.projectName = name
  const transforms = getFlag(ctx.flags, 'transforms-json')
  if (transforms)
    input.transforms = await readJsonArgument(transforms, '--transforms-json')
  if (previous && input.transforms) {
    delete input.quickRunId
    delete input.quickScene
  }
  const canvasId = selectedCanvasId(ctx.flags) ?? previous?.canvas.id
  if (previous && canvasId !== previous.canvas.id)
    throw new Error(
      'Recomposition must use the original canvas to retain lineage',
    )
  const operationId = getFlag(ctx.flags, 'operation-id')
  if (nodeId && operationId) {
    const resumeOptions = {
      ...stateOptions(ctx),
      operationId,
      expectedCanvasId: canvasId,
      expectedCanvasNodeId: nodeId,
      expectedOperation: 'mesh.compose' as const,
      expectedBody: input,
    }
    // A mesh batch reserves its root key even though its paid requests have child keys.
    await resumeNodeMeshBatch(resumeOptions)
    if (await hasRecordedOperation(resumeOptions.stateDir, operationId)) {
      await printRecorded(ctx, await resumeRecorded(resumeOptions))
      return
    }
  }
  const session = await openExecutionSession({
    ...stateOptions(ctx),
    canvasId,
    operation: 'mesh.compose',
    ...(nodeId ? {create: false} : {}),
  })
  if (nodeId) {
    const {items} = await ctx.client.v2.listCanvasNodes(session.canvas.id)
    const target = items.find(item => item.nodeId === nodeId)
    if (
      !target ||
      !['production-3d', 'part-composer'].includes(target.type) ||
      !target.actions.includes('mesh.compose')
    )
      throw new Error('Composition is unavailable for this canvas node')
  }
  const queued = await executeRecorded(
    session,
    'mesh.compose',
    input as Omit<MeshComposeRequest, 'executionContext'>,
    {
      ...executionOptions(ctx.flags),
      ...(previous ? {parentRunId: previous.runId} : {}),
      ...(nodeId ? {canvasNode: {nodeId}} : {}),
    },
  )
  await printRecorded(ctx, queued)
}

const commandMesh = async (
  subcommand: string | undefined,
  positionals: string[],
  ctx: CommandContext,
): Promise<void> => {
  if (subcommand === 'list') {
    print(
      await ctx.client.v2.listMeshes({
        query: getFlag(ctx.flags, 'query'),
        ...pageOptions(ctx.flags),
      }),
    )
    return
  }

  if (subcommand === 'get') {
    print(
      await ctx.client.v2.getAsset(
        requirePositional(positionals, 2, 'mesh-asset-id'),
      ),
    )
    return
  }

  if (subcommand === 'download') {
    const assetId = requirePositional(positionals, 2, 'mesh-asset-id')
    const asset = await ctx.client.v2.getAsset(assetId)
    const downloads = await maybeDownloadUrls(
      {...ctx.flags, download: true},
      asset,
    )
    print({asset, downloads})
    return
  }

  if (subcommand === 'generate') {
    const nodeId = canvasNodeFlag(ctx.flags)
    if (nodeId) {
      await commandNodeMesh(ctx, nodeId)
      return
    }
    const inputJson = getFlag(ctx.flags, 'input-json')
    const input = inputJson
      ? await readJsonArgument(inputJson, '--input-json')
      : {
          modelId: getFlag(ctx.flags, 'model-id') ?? defaultMeshModelId,
          name: getFlag(ctx.flags, 'name'),
          faceLimit:
            getFlag(ctx.flags, 'face-limit') == null
              ? undefined
              : parsePositiveIntegerFlag(ctx.flags, 'face-limit', 1),
          isLowPoly: parseBooleanFlag(ctx.flags, 'low-poly'),
        }
    const session = await openExecutionSession({
      ...stateOptions(ctx),
      canvasId: selectedCanvasId(ctx.flags),
      operation: 'mesh.generate',
    })
    const graphInput = await graphSourceInput(ctx, session.canvas.id)
    const source =
      graphInput?.source ??
      (await recordedSource(
        ctx,
        inputJson
          ? (input.source as Source | undefined)
          : await resolveSource({
              flags: ctx.flags,
              client: ctx.client,
              fileMediaType: 'image',
              preferUploadId: true,
            }),
      ))
    if (source) input.source = source
    if (Array.isArray(input.sources))
      input.sources = await Promise.all(
        input.sources.map(source => recordedSource(ctx, source as Source)),
      )
    if (!input.source && !input.sources) throw new Error(missingSourceMessage)
    await printRecorded(
      ctx,
      await executeRecorded(
        session,
        'mesh.generate',
        input as MeshGenerationRequest,
        {...executionOptions(ctx.flags), graphSource: graphInput?.graphSource},
      ),
    )
    return
  }

  if (subcommand === 'retopo') {
    const queued = await ctx.client.v2.retopo({
      source: await requireSource({
        flags: ctx.flags,
        client: ctx.client,
        fileMediaType: 'mesh',
      }),
      modelId: requireFlag(ctx.flags, 'model-id'),
      name: getFlag(ctx.flags, 'name'),
      faceLevel: getFlag(ctx.flags, 'face-level'),
      polygonType: getFlag(ctx.flags, 'polygon-type'),
    })
    const job = await pollIfRequested({ctx, jobId: queued.jobId})
    print(await withOptionalDownloads(ctx.flags, {queued, job}))
    return
  }

  throw new Error(
    'Unknown mesh command. Use "mesh list|get|download|generate|retopo".',
  )
}

/**
 * Accepted values for the rig/animate enum flags, kept next to the commands
 * that read them. `satisfies` ties each list to the client's own type, so a
 * new rig type or output format added there fails to compile here rather than
 * silently going unvalidated.
 */
const RIG_MODEL_VERSIONS = [
  'v1.0-20240301',
  'v2.5-20260210',
] as const satisfies readonly NonNullable<RigRequest['model']>[]
const RIG_TYPES = [
  'biped',
  'quadruped',
  'hexapod',
  'octopod',
  'avian',
  'serpentine',
  'aquatic',
] as const satisfies readonly RigType[]
const RIG_SPECS = ['tripo', 'mixamo'] as const satisfies readonly NonNullable<
  RigRequest['spec']
>[]
const RIG_OUT_FORMATS = ['glb', 'fbx'] as const satisfies readonly NonNullable<
  RigRequest['outFormat']
>[]

/**
 * `/animations/retarget` caps `animations` at five server-side. Rejecting the
 * sixth here means the user sees the limit before a request is built, rather
 * than a 400 after typing them all out.
 */
const MAX_RETARGET_ANIMATIONS = 5

/**
 * The `animate retarget` request, built from flags alone.
 *
 * Split out of the command — like `parseRunsUploadArgs` — so the parts worth
 * testing (the required/at-most-five guards and the single-vs-plural field
 * choice) need no client or network.
 */
export const buildAnimationRetargetRequest = (
  flags: Flags,
): AnimationRetargetRequest => {
  const resourceId = requireFlag(flags, 'resource-id')
  const animations = getFlagValues(flags, 'animation')
  const [firstAnimation] = animations
  if (firstAnimation == null) {
    throw new Error('Missing required flag: --animation')
  }
  if (animations.length > MAX_RETARGET_ANIMATIONS) {
    throw new Error(
      `--animation accepts at most ${MAX_RETARGET_ANIMATIONS} values, got ${animations.length}`,
    )
  }
  const base = {
    resourceId,
    outFormat: parseEnumFlag(flags, 'out-format', RIG_OUT_FORMATS),
    bakeAnimation: parseBooleanFlag(flags, 'bake-animation'),
    exportWithGeometry: parseBooleanFlag(flags, 'export-with-geometry'),
    animateInPlace: parseBooleanFlag(flags, 'animate-in-place'),
    name: getFlag(flags, 'name'),
  }
  // Built per branch rather than spread-then-cast: `animation` and
  // `animations` are mutually exclusive in the request type, and a cast over
  // the whole object would stop checking the other six fields too.
  return animations.length === 1
    ? {...base, animation: firstAnimation}
    : {...base, animations}
}

/**
 * Everything `rig create` sends apart from the source, which needs a client to
 * resolve. Separated for the same reason as `buildAnimationRetargetRequest`:
 * the flag validation is the part worth testing.
 */
export const buildRigCreateOptions = (
  flags: Flags,
): Omit<RigRequest, 'source'> => ({
  model: parseEnumFlag(flags, 'model', RIG_MODEL_VERSIONS),
  rigType: parseEnumFlag(flags, 'rig-type', RIG_TYPES),
  spec: parseEnumFlag(flags, 'spec', RIG_SPECS),
  outFormat: parseEnumFlag(flags, 'out-format', RIG_OUT_FORMATS),
  name: getFlag(flags, 'name'),
})

const commandRig = async (
  subcommand: string | undefined,
  ctx: CommandContext,
): Promise<void> => {
  if (subcommand === 'check') {
    const queued = await ctx.client.v2.checkRig({
      source: await requireSource({
        flags: ctx.flags,
        client: ctx.client,
        fileMediaType: 'mesh',
      }),
      name: getFlag(ctx.flags, 'name'),
    })
    const job = await pollIfRequested({ctx, jobId: queued.jobId})
    print(await withOptionalDownloads(ctx.flags, {queued, job}))
    return
  }

  if (subcommand === 'create') {
    const queued = await ctx.client.v2.rigMesh({
      source: await requireSource({
        flags: ctx.flags,
        client: ctx.client,
        fileMediaType: 'mesh',
      }),
      ...buildRigCreateOptions(ctx.flags),
    })
    const job = await pollIfRequested({ctx, jobId: queued.jobId})
    print(await withOptionalDownloads(ctx.flags, {queued, job}))
    return
  }

  throw new Error('Unknown rig command. Use "rig check" or "rig create".')
}

const commandAnimate = async (
  subcommand: string | undefined,
  ctx: CommandContext,
): Promise<void> => {
  if (subcommand === 'presets') {
    const result = await ctx.client.v2.listAnimationPresets({
      model: parseEnumFlag(ctx.flags, 'model', RIG_MODEL_VERSIONS),
      rigType: parseEnumFlag(ctx.flags, 'rig-type', RIG_TYPES),
    })
    print(result)
    return
  }

  if (subcommand === 'retarget') {
    const queued = await ctx.client.v2.retargetAnimation(
      buildAnimationRetargetRequest(ctx.flags),
    )
    const job = await pollIfRequested({ctx, jobId: queued.jobId})
    print(await withOptionalDownloads(ctx.flags, {queued, job}))
    return
  }

  throw new Error(
    'Unknown animate command. Use "animate presets" or "animate retarget".',
  )
}

const commandJobs = async (
  subcommand: string | undefined,
  positionals: string[],
  ctx: CommandContext,
): Promise<void> => {
  const jobId = requirePositional(positionals, 2, 'job-id')

  if (subcommand === 'get') {
    const job = await ctx.client.v2.getJob(jobId)
    print(await withOptionalDownloads(ctx.flags, {job}))
    return
  }

  if (subcommand === 'watch') {
    const job = await ctx.client.v2.pollJob(jobId, {
      intervalMs: parsePositiveIntegerFlag(ctx.flags, 'interval-ms', 5000),
      timeoutMs: parsePositiveIntegerFlag(ctx.flags, 'timeout-ms', 900000),
      onPoll: current => {
        stderr.write(`[poll] job=${current.id} status=${current.status}\n`)
      },
    })
    print(await withOptionalDownloads(ctx.flags, {job}))
    return
  }

  throw new Error('Unknown jobs command. Use "jobs get" or "jobs watch".')
}

const resolvePartExtractorFromMission = async (
  ctx: CommandContext,
  orderId: string,
  missionId: string,
): Promise<string> => {
  const status = await ctx.client.v1.getProductionStatus(orderId)
  const mission = status.missions.find(item => item.id === missionId)
  if (mission?.agentVersion == null || mission.agentVersion.trim() === '') {
    throw new Error(
      'Could not infer the part extractor from the mission. Pass --part-extractor with one of: ' +
        partExtractorPublicNames,
    )
  }

  const publicName = publicPartExtractorName(mission.agentVersion)
  if (publicName == null || publicName === 'Unknown') {
    throw new Error(
      'Could not infer the public part extractor from the mission. Pass --part-extractor with one of: ' +
        partExtractorPublicNames,
    )
  }
  return resolvePartExtractorApiValue(publicName)
}

type DownloadManifestEntry = {
  url: string
  path: string
  contentType: string | null
  bytes: number
}

const redactUrl = (value: string): string => {
  try {
    const url = new URL(value)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}

const collectHttpUrls = (
  value: unknown,
  urls = new Set<string>(),
): Set<string> => {
  if (typeof value === 'string') {
    try {
      const url = new URL(value)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        urls.add(value)
      }
    } catch {
      // Ignore non-URL strings.
    }
    return urls
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectHttpUrls(item, urls)
    }
    return urls
  }

  if (value != null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectHttpUrls(item, urls)
    }
  }
  return urls
}

const extensionFromContentType = (contentType: string | null): string => {
  if (contentType == null) {
    return ''
  }
  const clean = contentType.split(';')[0]?.trim().toLowerCase()
  switch (clean) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    case 'model/gltf-binary':
      return '.glb'
    case 'model/gltf+json':
      return '.gltf'
    case 'application/octet-stream':
    default:
      return ''
  }
}

const safeDownloadFileName = (
  value: string,
  index: number,
  contentType: string | null,
): string => {
  let name = `asset-${index + 1}`
  try {
    const url = new URL(value)
    const fromPath = basename(url.pathname)
    if (fromPath !== '' && fromPath !== '/' && fromPath !== '.') {
      name = fromPath
    }
  } catch {
    // Keep fallback name.
  }

  name = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+/, '')
  if (name === '' || name === '.' || name === '..') {
    name = `asset-${index + 1}`
  }
  if (extname(name) === '') {
    name = `${name}${extensionFromContentType(contentType)}`
  }
  return `${String(index + 1).padStart(3, '0')}-${name}`
}

const maybeDownloadUrls = async (
  flags: Flags,
  value: unknown,
): Promise<{outDir: string; files: DownloadManifestEntry[]} | undefined> => {
  if (!hasFlag(flags, 'download')) {
    return undefined
  }

  const outDir = getFlag(flags, 'out-dir') ?? getFlag(flags, 'out')
  if (outDir == null || outDir === 'true') {
    throw new Error(
      'Missing download output directory. Pass --out-dir <dir> or --out <dir>.',
    )
  }
  await mkdir(outDir, {recursive: true})

  const urls = [...collectHttpUrls(value)]
  const files: DownloadManifestEntry[] = []
  for (const [index, url] of urls.entries()) {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `Download failed: ${redactUrl(url)} returned HTTP ${response.status}`,
      )
    }
    const contentType = response.headers.get('content-type')
    const bytes = new Uint8Array(await response.arrayBuffer())
    const fileName = safeDownloadFileName(url, index, contentType)
    const filePath = join(outDir, fileName)
    await writeFile(filePath, bytes)
    files.push({
      url: redactUrl(url),
      path: filePath,
      contentType,
      bytes: bytes.byteLength,
    })
  }

  const manifest = {generatedAt: new Date().toISOString(), files}
  await writeFile(
    join(outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return {outDir, files}
}

const withOptionalDownloads = async (
  flags: Flags,
  value: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const downloads = await maybeDownloadUrls(flags, value)
  return downloads == null ? value : {...value, downloads}
}

const firstStringValueForKeys = (
  value: unknown,
  keys: Set<string>,
): string | undefined => {
  if (value == null || typeof value !== 'object') {
    return undefined
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstStringValueForKeys(item, keys)
      if (found != null) {
        return found
      }
    }
    return undefined
  }

  for (const [key, entry] of Object.entries(value)) {
    if (keys.has(key) && typeof entry === 'string' && entry.trim() !== '') {
      return entry
    }
    const found = firstStringValueForKeys(entry, keys)
    if (found != null) {
      return found
    }
  }
  return undefined
}

const firstBlobLocation = (value: unknown): BlobLocation | undefined => {
  if (value == null || typeof value !== 'object') {
    return undefined
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstBlobLocation(item)
      if (found != null) {
        return found
      }
    }
    return undefined
  }

  const record = value as Record<string, unknown>
  if (
    record.type === 'supabase' &&
    typeof record.bucket === 'string' &&
    typeof record.path === 'string'
  ) {
    return {
      type: 'supabase',
      bucket: record.bucket,
      path: record.path,
    }
  }
  if (
    record.type === 'signedSupabase' &&
    typeof record.signedUrl === 'string'
  ) {
    return {
      type: 'signedSupabase',
      signedUrl: record.signedUrl,
    }
  }
  if (record.type === 'asset' && typeof record.assetId === 'string') {
    return {
      type: 'asset',
      assetId: record.assetId,
    }
  }

  for (const entry of Object.values(record)) {
    const found = firstBlobLocation(entry)
    if (found != null) {
      return found
    }
  }
  return undefined
}

const imageSourceFromCompletedJob = (
  job: Job,
): ProductionAnalyzeSourceInput => {
  if (job.resourceId != null && job.resourceId.trim() !== '') {
    return {imageAssetId: job.resourceId}
  }

  const resourceId = firstStringValueForKeys(
    job,
    new Set([
      'resourceId',
      'resource_id',
      'assetId',
      'asset_id',
      'imageAssetId',
    ]),
  )
  if (resourceId != null) {
    return {imageAssetId: resourceId}
  }

  const imageUrl = firstStringValueForKeys(
    job,
    new Set(['imageUrl', 'image_url', 'url', 'publicUrl', 'public_url']),
  )
  if (imageUrl != null) {
    return {imageUrl}
  }

  const blobLocation = firstBlobLocation(job)
  if (blobLocation != null) {
    return {imageBlobLocation: blobLocation}
  }

  throw new Error(
    'Preprocessing completed, but the image job did not include an image source for part splitting.',
  )
}

const errorToOutput = (error: unknown): Record<string, unknown> => {
  if (error instanceof CliExecutionError)
    return {
      message: error.message,
      exitCode: error.exitCode,
      operationId: error.operationId,
      runId: error.runId,
      execution: error.execution,
    }
  if (error instanceof AssetHubApiError) {
    return {
      name: error.name,
      message: error.message,
      status: error.status,
      code: error.code,
    }
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    }
  }
  return {message: String(error)}
}

const readyTaskIdsFromStatus = (status: unknown): string[] => {
  const missions =
    status != null && typeof status === 'object' && 'missions' in status
      ? (status as {missions?: unknown}).missions
      : undefined
  if (!Array.isArray(missions)) {
    return []
  }

  return missions.flatMap(mission => {
    if (
      mission == null ||
      typeof mission !== 'object' ||
      !('tasks' in mission)
    ) {
      return []
    }
    const tasks = (mission as {tasks?: unknown}).tasks
    if (!Array.isArray(tasks)) {
      return []
    }
    return tasks.flatMap(task => {
      if (task == null || typeof task !== 'object') {
        return []
      }
      const id = (task as {id?: unknown}).id
      const taskStatus = (task as {status?: unknown}).status
      return typeof id === 'string' &&
        typeof taskStatus === 'string' &&
        ['ready', 'pending', 'pending_review'].includes(taskStatus)
        ? [id]
        : []
    })
  })
}

const singleMissionIdFromStatus = (status: unknown): string => {
  const missions =
    status != null && typeof status === 'object' && 'missions' in status
      ? (status as {missions?: unknown}).missions
      : undefined
  if (!Array.isArray(missions) || missions.length !== 1) {
    throw new Error(
      'Pass --mission-id when the production order does not have exactly one mission.',
    )
  }
  const missionId = (missions[0] as {id?: unknown}).id
  if (typeof missionId !== 'string' || missionId.trim() === '') {
    throw new Error('Could not infer mission id. Pass --mission-id.')
  }
  return missionId
}

/**
 * Flag forms for the intervention ops, one per contract op.
 *
 * `params.set` has no `--params-set`: parameters arrive as repeated
 * `--set-param key=value` and merge into a single op (see below).
 */
const interventionOpFlags = [
  'add-part',
  'exclude',
  'include',
  'regenerate',
  'reject',
  'rename',
  'set-param',
] as const

type InterventionOpFlag = (typeof interventionOpFlags)[number]

const isInterventionOpFlag = (name: string): name is InterventionOpFlag =>
  (interventionOpFlags as readonly string[]).includes(name)

/** Splits on the FIRST `=` so a value may itself contain one. */
const splitOnFirstEquals = (value: string): [string, string | undefined] => {
  const index = value.indexOf('=')
  return index === -1
    ? [value, undefined]
    : [value.slice(0, index), value.slice(index + 1)]
}

const requireOpValue = (
  flag: string,
  value: string | undefined,
  shape: string,
): string => {
  if (value == null || value.trim().length === 0) {
    throw new Error(`--${flag} requires a value: --${flag} ${shape}`)
  }
  return value
}

/**
 * Builds an intervention batch from the raw argument slice.
 *
 * Raw argv rather than the parsed `Flags` record on purpose: that record is
 * keyed by flag name, so it can report every `--exclude` but not whether one of
 * them preceded an `--add-part`. The batch's order becomes the log's `seq`
 * order, which is the order the operator made the decisions in, so it has to
 * survive parsing.
 *
 * Repeated `--set-param` flags merge into ONE `params.set` op, emitted at the
 * position of the first of them. Two parameters set in the same invocation are
 * one decision; writing them as two log rows would make the log claim the
 * operator changed their mind halfway through.
 *
 * Values are not validated against the contract's key set. The CLI carries no
 * zod and must not carry a second copy of the contract either -- an unknown
 * param key is the server's 400 to give, from the one place the contract is
 * enforced. Only the shape this function itself has to parse is checked here.
 */
export const interventionOpsFromArgs = (
  args: readonly string[],
): Intervention[] => {
  const ops: Intervention[] = []
  let paramsOp: {op: 'params.set'; patch: Record<string, string>} | null = null

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue

    const [rawName, inlineValue] = splitOnFirstEquals(arg.slice(2))
    const flag = rawName.trim()
    if (!isInterventionOpFlag(flag)) continue

    const next = args[index + 1]
    const value =
      inlineValue != null
        ? inlineValue
        : next != null && !next.startsWith('--')
          ? ((index += 1), next)
          : undefined

    if (flag === 'add-part') {
      ops.push({op: 'part.add', name: requireOpValue(flag, value, '<name>')})
      continue
    }

    if (flag === 'exclude' || flag === 'include') {
      ops.push({
        op: flag === 'exclude' ? 'part.exclude' : 'part.include',
        targetId: requireOpValue(flag, value, '<target-id>'),
      })
      continue
    }

    if (flag === 'rename') {
      const [targetId, name] = splitOnFirstEquals(
        requireOpValue(flag, value, '<target-id>=<name>'),
      )
      if (
        targetId.trim().length === 0 ||
        name == null ||
        name.trim().length === 0
      ) {
        throw new Error('--rename requires --rename <target-id>=<name>')
      }
      ops.push({op: 'part.rename', targetId, name})
      continue
    }

    if (flag === 'regenerate') {
      const [targetId, mode] = splitOnFirstEquals(
        requireOpValue(flag, value, '<target-id>=<mode>'),
      )
      if (
        targetId.trim().length === 0 ||
        mode == null ||
        mode.trim().length === 0
      ) {
        throw new Error('--regenerate requires --regenerate <target-id>=<mode>')
      }
      ops.push({op: 'part.regenerate', targetId, mode})
      continue
    }

    if (flag === 'reject') {
      const [targetId, reason] = splitOnFirstEquals(
        requireOpValue(flag, value, '<target-id>[=<reason>]'),
      )
      if (targetId.trim().length === 0) {
        throw new Error('--reject requires --reject <target-id>[=<reason>]')
      }
      // `--reject 7=` is a typo, not "no reason": the contract rejects a blank
      // one, so it is refused here rather than round-tripped for a 400.
      if (reason != null && reason.trim().length === 0) {
        throw new Error('--reject reason must not be blank')
      }
      ops.push(
        reason == null
          ? {op: 'part.reject', targetId}
          : {op: 'part.reject', targetId, reason},
      )
      continue
    }

    const [key, paramValue] = splitOnFirstEquals(
      requireOpValue(flag, value, '<key>=<value>'),
    )
    if (
      key.trim().length === 0 ||
      paramValue == null ||
      paramValue.trim().length === 0
    ) {
      throw new Error('--set-param requires --set-param <key>=<value>')
    }
    if (paramsOp == null) {
      paramsOp = {op: 'params.set', patch: {}}
      // Cast because the patch is intentionally open here: the contract's key
      // set is enforced server-side, in one place, not duplicated in the CLI.
      ops.push(paramsOp as unknown as Intervention)
    }
    paramsOp.patch[key] = paramValue
  }

  return ops
}

const readOpsJsonFlag = async (flags: Flags): Promise<Intervention[]> => {
  const value = getFlag(flags, 'ops-json')
  if (value == null || value === 'true' || value.trim() === '') {
    throw new Error('Missing required flag value: --ops-json <json|@file|@->')
  }
  const raw =
    value === '@-' || value === '-'
      ? await readStdin()
      : value.startsWith('@')
        ? await readFile(value.slice(1), 'utf8')
        : value
  const parsed = parseJsonValue(raw, '--ops-json')
  if (!Array.isArray(parsed)) {
    throw new Error('--ops-json must be a JSON array of intervention ops')
  }
  return parsed as Intervention[]
}

const productionSession = (
  ctx: CommandContext,
  operation:
    | 'production.analyze'
    | 'production.execute'
    | 'production.automation',
) =>
  openExecutionSession({
    ...stateOptions(ctx),
    canvasId: selectedCanvasId(ctx.flags),
    operation,
  })

const commandProduction = async (
  subcommand: string | undefined,
  positionals: string[],
  ctx: CommandContext,
): Promise<void> => {
  if (subcommand === 'agents') {
    print(sanitizeProductionOutput(await ctx.client.v1.getProductionAgents()))
    return
  }
  if (subcommand === 'analyze') {
    const session = await productionSession(ctx, 'production.analyze')
    const analyzed = await executeRecorded(
      session,
      'production.analyze',
      {
        ...(await resolveProductionAnalyzeSource(ctx)),
        agentVersion: resolvePartExtractorForAnalyze(ctx.flags),
        name: getFlag(ctx.flags, 'name'),
      },
      executionOptions(ctx.flags),
    )
    await printRecorded(ctx, analyzed)
    return
  }

  if (subcommand === 'automation') {
    const session = await productionSession(ctx, 'production.automation')
    const input = getFlag(ctx.flags, 'input-json')
    const body = input
      ? await readJsonArgument(input, '--input-json')
      : {
          images: [await resolveProductionAnalyzeSource(ctx)],
          agentVersion: resolvePartExtractorForAnalyze(ctx.flags),
          name: getFlag(ctx.flags, 'name'),
        }
    if (!Array.isArray(body.images) || !body.images.length)
      throw new Error('production automation requires non-empty images[]')
    const images = await Promise.all(
      body.images.map(async image => {
        if (!image || typeof image !== 'object')
          throw new Error('Invalid automation image source')
        return productionAnalyzeSourceFromSource(
          (await recordedSource(
            ctx,
            sourceFromProductionAnalyzeSource(image),
          ))!,
        )
      }),
    )
    const queued = await executeRecorded(
      session,
      'production.automation',
      {
        ...body,
        images,
        agentVersion:
          body.agentVersion ?? resolvePartExtractorForAnalyze(ctx.flags),
        ...(getFlag(ctx.flags, 'max-cost-credits')
          ? {
              maxCostCredits: parsePositiveIntegerFlag(
                ctx.flags,
                'max-cost-credits',
                1,
              ),
            }
          : {}),
      } as ProductionAutomationRequest,
      executionOptions(ctx.flags),
    )
    await printRecorded(ctx, queued)
    return
  }

  if (subcommand === 'status') {
    const orderId = requirePositional(positionals, 2, 'order-id')
    const status = hasFlag(ctx.flags, 'wait')
      ? await pollProductionStatus({
          ctx,
          orderId,
          terminalStatuses: new Set([
            ...productionAnalyzeTerminalStatuses,
            ...productionExecuteTerminalStatuses,
          ]),
        })
      : await ctx.client.v1.getProductionStatus(orderId)
    print(
      await withOptionalDownloads(
        ctx.flags,
        sanitizeProductionOutput({status}) as Record<string, unknown>,
      ),
    )
    return
  }

  if (subcommand === 'execute') {
    const confirmedTaskIds = getFlagValues(ctx.flags, 'task-id')
    if (confirmedTaskIds.length === 0) {
      throw new Error('Missing required flag: --task-id')
    }
    const partExtractionMode = getFlag(ctx.flags, 'part-extraction-mode')
    if (
      partExtractionMode != null &&
      partExtractionMode !== 'fast' &&
      partExtractionMode !== 'high_quality'
    ) {
      throw new Error('--part-extraction-mode must be "fast" or "high_quality"')
    }

    const orderId = requireFlag(ctx.flags, 'order-id')
    const missionId = requireFlag(ctx.flags, 'mission-id')
    const partExtractorFlag = getPartExtractorFlag(ctx.flags)
    const agentVersion =
      partExtractorFlag == null
        ? await resolvePartExtractorFromMission(ctx, orderId, missionId)
        : resolvePartExtractorApiValue(partExtractorFlag)

    const session = await productionSession(ctx, 'production.execute')
    const executed = await executeRecorded(
      session,
      'production.execute',
      {
        orderId,
        missionId,
        confirmedTaskIds,
        agentVersion,
        partExtractionMode,
      },
      executionOptions(ctx.flags),
    )
    await printRecorded(ctx, executed)
    return
  }

  if (subcommand === 'run') {
    const orderId = requireFlag(ctx.flags, 'order-id')
    const missionId = requireFlag(ctx.flags, 'mission-id')
    const runMode = parseRunModeFlag(ctx.flags)
    const partExtractionMode = getFlag(ctx.flags, 'part-extraction-mode')
    if (
      partExtractionMode != null &&
      partExtractionMode !== 'fast' &&
      partExtractionMode !== 'high_quality'
    ) {
      throw new Error('--part-extraction-mode must be "fast" or "high_quality"')
    }

    const partExtractorFlag = getPartExtractorFlag(ctx.flags)
    const agentVersion =
      partExtractorFlag == null
        ? await resolvePartExtractorFromMission(ctx, orderId, missionId)
        : resolvePartExtractorApiValue(partExtractorFlag)

    const confirmedTaskIds = getFlagValues(ctx.flags, 'task-id')
    const allowedModelIds = getFlagValues(ctx.flags, 'allowed-model-id')
    const maxIterations =
      getFlag(ctx.flags, 'max-iterations') == null
        ? undefined
        : parsePositiveIntegerFlag(ctx.flags, 'max-iterations', 1)
    const maxCostCredits =
      getFlag(ctx.flags, 'max-cost-credits') == null
        ? undefined
        : parsePositiveIntegerFlag(ctx.flags, 'max-cost-credits', 1)

    const started = await ctx.client.v1.runProduction({
      orderId,
      missionId,
      agentVersion,
      runMode,
      ...(confirmedTaskIds.length > 0 ? {confirmedTaskIds} : {}),
      ...(allowedModelIds.length > 0 ? {allowedModelIds} : {}),
      ...(partExtractionMode != null
        ? {partExtractionMode: partExtractionMode as 'fast' | 'high_quality'}
        : {}),
      ...(maxIterations != null ? {maxIterations} : {}),
      ...(maxCostCredits != null ? {maxCostCredits} : {}),
    })
    const status = hasFlag(ctx.flags, 'wait')
      ? await watchProductionRun({ctx, orderId})
      : undefined
    print(
      await withOptionalDownloads(
        ctx.flags,
        sanitizeProductionOutput({started, status}) as Record<string, unknown>,
      ),
    )
    return
  }

  if (subcommand === 'interventions') {
    const orderId = requirePositional(positionals, 2, 'order-id')
    print(await ctx.client.v2.listInterventions(orderId))
    return
  }

  if (subcommand === 'intervene') {
    const orderId = requirePositional(positionals, 2, 'order-id')
    const usesOpsJson = hasFlag(ctx.flags, 'ops-json')
    const flagOps = interventionOpsFromArgs(ctx.args)
    // Refused rather than concatenated: with both present the batch's order
    // would depend on which source the CLI happened to read first, and that
    // order becomes the log's seq order.
    if (usesOpsJson && flagOps.length > 0) {
      throw new Error(
        'Use either --ops-json or the individual op flags, not both.',
      )
    }
    const interventions = usesOpsJson
      ? await readOpsJsonFlag(ctx.flags)
      : flagOps
    if (interventions.length === 0) {
      throw new Error(
        'No interventions given. Use --exclude/--include/--add-part/--rename/--reject/--regenerate/--set-param, or --ops-json.',
      )
    }
    const idempotencyKey = getFlag(ctx.flags, 'idempotency-key')
    const appended = await ctx.client.v2.appendInterventions(
      orderId,
      interventions,
      // Omitted rather than passed as undefined so the request carries no header
      // at all; the server then reports `idempotent: false` back.
      idempotencyKey == null ? {} : {idempotencyKey},
    )
    print({appended, interventions})
    return
  }

  if (subcommand === 'watch') {
    const orderId = requirePositional(positionals, 2, 'order-id')
    const status = await watchProductionRun({ctx, orderId})
    print(
      await withOptionalDownloads(
        ctx.flags,
        sanitizeProductionOutput({status}) as Record<string, unknown>,
      ),
    )
    return
  }

  throw new Error(
    'Unknown production command. Use "production agents", "production analyze", "production automation", "production run", "production watch", "production status", "production execute", "production intervene", or "production interventions".',
  )
}

// Multi-phase commands may contain several receipts; only their durable outputs
// are downloadable, never canvas links, source URLs or evaluation evidence URLs.
const recordedOutputs = (value: unknown): CanvasExecution['outputs'] => {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(recordedOutputs)
  return Object.entries(value).flatMap(([key, item]) => {
    if (
      key === 'execution' &&
      item &&
      typeof item === 'object' &&
      'outputs' in item &&
      Array.isArray(item.outputs)
    )
      return item.outputs as CanvasExecution['outputs']
    return recordedOutputs(item)
  })
}

const isArtifactGraphPartSplit = (
  value: unknown,
  execution: CanvasExecution,
): boolean =>
  (value != null &&
    typeof value === 'object' &&
    'engine' in value &&
    value.engine === 'artifact-graph') ||
  artifactGraphPartExtractorApiValues.has(
    String(execution.resolvedInput?.agentVersion),
  )

const commandParts = async (
  subcommand: string | undefined,
  ctx: CommandContext,
): Promise<void> => {
  const runPartSplit = async (
    source?: ProductionAnalyzeSourceInput,
    operationId = getFlag(ctx.flags, 'operation-id') ?? randomUUID(),
  ): Promise<Record<string, unknown>> => {
    let orderId = source == null ? getFlag(ctx.flags, 'order-id') : undefined
    if (orderId != null) {
      orderId = assertFlagHasValue(orderId, '--order-id <id>')
    }
    const partExtractorFlag = getPartExtractorFlag(ctx.flags)
    const requestedAgentVersion =
      orderId == null || partExtractorFlag != null
        ? resolvePartExtractorApiValue(
            partExtractorFlag ?? defaultPartExtractorName,
          )
        : undefined
    if (
      requestedAgentVersion != null &&
      artifactGraphPartExtractorApiValues.has(requestedAgentVersion)
    ) {
      const publicName = publicPartExtractorName(requestedAgentVersion)
      for (const flag of ['task-id', 'mission-id', 'part-extraction-mode']) {
        if (hasFlag(ctx.flags, flag))
          throw new Error(`--${flag} is not supported with ${publicName}`)
      }
      if (orderId != null)
        throw new Error(
          `--order-id is not supported with ${publicName}; use runs resume <operation-id> to resume a graph split`,
        )
    }
    const session = await productionSession(
      ctx,
      orderId == null ? 'production.analyze' : 'production.execute',
    )
    let execution: CanvasExecution | undefined
    let analyzed: unknown
    let status: unknown
    if (orderId == null) {
      const result = await executeRecorded(
        session,
        'production.analyze',
        {
          ...(source ?? (await resolveProductionAnalyzeSource(ctx))),
          agentVersion: resolvePartExtractorForAnalyze(ctx.flags),
          name: getFlag(ctx.flags, 'name'),
        },
        {...executionOptions(ctx.flags), operationId},
      )
      analyzed = result
      execution = result.execution
      if (isArtifactGraphPartSplit(result, execution)) {
        stderr.write(
          `[run] ${execution.runId} graph=${execution.orderIds[0] ?? execution.runId}\n`,
        )
        if (hasFlag(ctx.flags, 'wait') || hasFlag(ctx.flags, 'all-ready'))
          execution = await waitForExecution(
            ctx.client,
            execution.runId,
            watchOptions(ctx.flags),
          )
        process.exitCode = executionExitCode(execution)
        return sanitizeProductionOutput({execution, analyzed}) as Record<
          string,
          unknown
        >
      }
      orderId = execution.orderIds[0]
      if (!orderId)
        throw new CliExecutionError(
          'Analysis receipt omitted its order',
          3,
          operationId,
          execution,
        )
      stderr.write(`[run] ${execution.runId} order=${orderId}\n`)
      const executeOperationId = childOperationId(operationId, 'execute')
      if (
        (hasFlag(ctx.flags, 'all-ready') ||
          getFlagValues(ctx.flags, 'task-id').length > 0) &&
        (await hasRecordedOperation(session.stateDir, executeOperationId))
      ) {
        const resumed = await resumeRecorded({
          ...stateOptions(ctx),
          operationId: executeOperationId,
          expectedCanvasId: session.canvas.id,
          expectedBodySubset: {
            partExtractionMode: getFlag(ctx.flags, 'part-extraction-mode'),
            ...(getFlagValues(ctx.flags, 'task-id').length
              ? {confirmedTaskIds: getFlagValues(ctx.flags, 'task-id')}
              : {}),
            ...(getFlag(ctx.flags, 'mission-id')
              ? {missionId: getFlag(ctx.flags, 'mission-id')}
              : {}),
          },
        })
        const execution =
          hasFlag(ctx.flags, 'wait') || hasFlag(ctx.flags, 'all-ready')
            ? await waitForExecution(
                ctx.client,
                resumed.execution.runId,
                watchOptions(ctx.flags),
              )
            : resumed.execution
        process.exitCode = executionExitCode(execution)
        return {execution, executed: sanitizeProductionOutput(resumed)}
      }
      if (hasFlag(ctx.flags, 'wait') || hasFlag(ctx.flags, 'all-ready')) {
        status = await pollProductionStatus({
          ctx,
          orderId,
          terminalStatuses: productionAnalyzeTerminalStatuses,
        })
      }
    } else if (hasFlag(ctx.flags, 'wait') || hasFlag(ctx.flags, 'all-ready')) {
      status = await pollProductionStatus({
        ctx,
        orderId,
        terminalStatuses: productionAnalyzeTerminalStatuses,
      })
    }

    let taskIds = getFlagValues(ctx.flags, 'task-id')
    if (hasFlag(ctx.flags, 'all-ready')) {
      if (status == null) {
        status = await ctx.client.v1.getProductionStatus(orderId)
      }
      taskIds = readyTaskIdsFromStatus(status)
      if (taskIds.length === 0) {
        throw new Error('No ready tasks were found for --all-ready.')
      }
    }

    let executed: unknown
    let executionStatus: unknown
    if (taskIds.length > 0) {
      if (status == null) {
        status = await ctx.client.v1.getProductionStatus(orderId)
      }
      const missionId =
        getFlag(ctx.flags, 'mission-id') ?? singleMissionIdFromStatus(status)
      const partExtractorFlag = getPartExtractorFlag(ctx.flags)
      const agentVersion =
        partExtractorFlag == null
          ? await resolvePartExtractorFromMission(ctx, orderId, missionId)
          : resolvePartExtractorApiValue(partExtractorFlag)
      const partExtractionMode = getFlag(ctx.flags, 'part-extraction-mode')
      if (
        partExtractionMode != null &&
        partExtractionMode !== 'fast' &&
        partExtractionMode !== 'high_quality'
      ) {
        throw new Error(
          '--part-extraction-mode must be "fast" or "high_quality"',
        )
      }

      const result = await executeRecorded(
        session,
        'production.execute',
        {
          orderId,
          missionId,
          confirmedTaskIds: taskIds,
          agentVersion,
          partExtractionMode,
        },
        {
          ...executionOptions(ctx.flags),
          operationId: execution
            ? childOperationId(operationId, 'execute')
            : operationId,
          parentRunId:
            execution?.runId ?? executionOptions(ctx.flags).parentRunId,
        },
      )
      executed = result
      execution = result.execution
      if (hasFlag(ctx.flags, 'wait')) {
        executionStatus = await pollProductionStatus({
          ctx,
          orderId,
          terminalStatuses: productionExecuteTerminalStatuses,
        })
      }
    }

    if (
      execution &&
      (hasFlag(ctx.flags, 'wait') || hasFlag(ctx.flags, 'all-ready'))
    ) {
      execution = await waitForExecution(
        ctx.client,
        execution.runId,
        watchOptions(ctx.flags),
      )
    }
    if (execution) process.exitCode = executionExitCode(execution)
    return sanitizeProductionOutput({
      execution,
      analyzed,
      status,
      executed,
      executionStatus,
    }) as Record<string, unknown>
  }

  if (subcommand === 'split') {
    if (
      getFlag(ctx.flags, 'order-id') != null &&
      sourceInputCount(ctx.flags) > 0
    ) {
      throw new Error('Pass either --order-id or one image source, not both.')
    }
    const result = await runPartSplit()
    const downloads = await maybeDownloadUrls(
      ctx.flags,
      recordedOutputs(result),
    )
    print({...result, ...(downloads ? {downloads} : {})})
    return
  }

  if (subcommand === 'compare') {
    if (getFlag(ctx.flags, 'order-id') != null) {
      throw new Error(
        'parts compare requires an image source. Use --file, --source-url, --source-id, --image-url, --file-ref-json, --stdin, --stdin-base64, --stdin-data-uri, --stdin-json, --source-json, --data-uri, or --clipboard.',
      )
    }

    const preprocessPrompt = getFlag(ctx.flags, 'preprocess-prompt')
    if (preprocessPrompt === 'true') {
      throw new Error('Missing required flag value: --preprocess-prompt <text>')
    }
    if (
      preprocessPrompt != null &&
      getFlagValues(ctx.flags, 'task-id').length > 0
    ) {
      throw new Error(
        'parts compare preprocessing creates a second order. Use --all-ready instead of --task-id.',
      )
    }
    if (preprocessPrompt != null && getFlag(ctx.flags, 'mission-id') != null) {
      throw new Error(
        'parts compare preprocessing creates a second order. Omit --mission-id and let the CLI infer it.',
      )
    }
    const preprocessModelId = getFlag(ctx.flags, 'preprocess-model-id')
    if (preprocessModelId === 'true') {
      throw new Error('Missing required flag value: --preprocess-model-id <id>')
    }

    const compareSession = await productionSession(ctx, 'production.analyze')
    const compareOperationId =
      getFlag(ctx.flags, 'operation-id') ?? randomUUID()
    const inputSource = productionAnalyzeSourceFromSource(
      await requireSource({
        flags: ctx.flags,
        client: ctx.client,
        fileMediaType: 'image',
        preferUploadId: true,
      }),
    )
    const durableInput = productionAnalyzeSourceFromSource(
      (await recordedSource(
        ctx,
        sourceFromProductionAnalyzeSource(inputSource),
      ))!,
    )
    const direct = await runPartSplit(durableInput, compareOperationId)
    let preprocessed: Record<string, unknown> | null = null

    if (preprocessPrompt != null && preprocessPrompt !== 'true') {
      const preprocessOperationId = childOperationId(
        compareOperationId,
        'preprocess',
      )
      try {
        const queued = await executeRecorded(
          compareSession,
          'image.generate',
          {
            source: sourceFromProductionAnalyzeSource(durableInput),
            prompt: preprocessPrompt,
            modelId: preprocessModelId ?? defaultImageModelId,
            batchSize: 1,
            negativePrompt: getFlag(ctx.flags, 'preprocess-negative-prompt'),
            seed:
              getFlag(ctx.flags, 'preprocess-seed') == null
                ? undefined
                : parsePositiveIntegerFlag(ctx.flags, 'preprocess-seed', 1),
          },
          {
            ...executionOptions(ctx.flags),
            operationId: preprocessOperationId,
          },
        )
        const completed = await waitForExecution(
          ctx.client,
          queued.execution.runId,
          watchOptions(ctx.flags),
        )
        const jobId = completed.jobIds[0]
        if (!jobId)
          throw new CliExecutionError(
            'Preprocessing omitted its job',
            3,
            undefined,
            completed,
          )
        const job = await ctx.client.v2.pollJob(jobId, {
          intervalMs: parsePositiveIntegerFlag(ctx.flags, 'interval-ms', 5000),
          timeoutMs: parsePositiveIntegerFlag(ctx.flags, 'timeout-ms', 900000),
          onPoll: current => {
            stderr.write(
              `[poll] preprocess job=${current.id} status=${current.status}\n`,
            )
          },
        })
        if (job.status !== 'completed') {
          throw new Error(
            `Preprocessing failed: job=${job.id} status=${job.status}`,
          )
        }
        const generatedSource = imageSourceFromCompletedJob(job)
        preprocessed = {
          ok: true,
          image: {
            queued,
            job,
            source: generatedSource,
          },
          split: await runPartSplit(
            generatedSource,
            childOperationId(compareOperationId, 'preprocessed-split'),
          ),
        }
      } catch (error) {
        const failure =
          error instanceof CliExecutionError ||
          activeExecution.operationId !== preprocessOperationId
            ? error
            : new CliExecutionError(
                error instanceof Error ? error.message : String(error),
                1,
                preprocessOperationId,
                activeExecution.execution,
                activeExecution.runId,
              )
        if (hasFlag(ctx.flags, 'fail-on-preprocess-error')) {
          throw failure
        }
        process.exitCode =
          failure instanceof CliExecutionError ? failure.exitCode : 1
        preprocessed = {
          ok: false,
          error: errorToOutput(failure),
        }
      }
    }

    const result = {direct, preprocessed}
    const downloads = await maybeDownloadUrls(
      ctx.flags,
      recordedOutputs(result),
    )
    print({...result, ...(downloads ? {downloads} : {})})
    return
  }

  throw new Error(
    'Unknown parts command. Use "parts split" or "parts compare".',
  )
}

const pageOptions = (flags: Flags) => ({
  cursor: getFlag(flags, 'cursor'),
  limit:
    getFlag(flags, 'limit') == null
      ? undefined
      : parsePositiveIntegerFlag(flags, 'limit', 50),
})
const canvasForRead = (ctx: CommandContext) =>
  openExecutionSession({
    ...stateOptions(ctx),
    canvasId: selectedCanvasId(ctx.flags),
    create: false,
  })
const commandCanvas = async (
  subcommand: string | undefined,
  positionals: string[],
  ctx: CommandContext,
) => {
  if (subcommand === 'nodes') {
    const {canvas} = await canvasForRead(ctx)
    print(await ctx.client.v2.listCanvasNodes(canvas.id))
    return
  }
  if (subcommand === 'download') {
    const outDir = requireFlag(ctx.flags, 'out-dir')
    const {canvas} = await canvasForRead(ctx)
    const mesh = getFlag(ctx.flags, 'mesh')
    if (mesh && !/^mesh_[1-9]\d*$/.test(mesh))
      throw new Error('--mesh must be a mesh_<id> asset ID')
    const result = await downloadCanvas({
      client: ctx.client,
      canvasId: canvas.id,
      mesh,
      outDir,
      progress: message => process.stderr.write(`${message}\n`),
    })
    print(result)
    process.exitCode = result.exitCode
    return
  }
  if (
    subcommand === 'context' ||
    subcommand === 'import' ||
    subcommand === 'compare' ||
    subcommand === 'layout'
  ) {
    const {canvas} = await canvasForRead(ctx)
    if (subcommand === 'context') {
      const action = positionals[2]
      if (action !== 'get' && action !== 'put')
        throw new Error('Use canvas context get|put')
      const result =
        action === 'get'
          ? await ctx.client.v2.getCanvasContext(canvas.id)
          : await ctx.client.v2.putCanvasContext(canvas.id, {
              document: await readJsonArgument(
                `@${requireFlag(ctx.flags, 'file')}`,
                '--file',
              ),
              expectedVersion: parseNonNegativeIntegerFlag(
                ctx.flags,
                'if-version',
              ),
            })
      const out = getFlag(ctx.flags, 'out')
      if (out) {
        await mkdir(dirname(resolve(out)), {recursive: true})
        await writeFile(
          resolve(out),
          JSON.stringify(result.projectContext.document, null, 2) + '\n',
          {mode: 0o600},
        )
      }
      print(result)
    } else if (subcommand === 'layout') {
      const input = await readJsonArgument(
        requireFlag(ctx.flags, 'input-json'),
        '--input-json',
      )
      print(
        await ctx.client.v2.appendCanvasLayout(
          canvas.id,
          input as CanvasLayoutInput,
        ),
      )
    } else if (subcommand === 'import') {
      const filePath = getFlag(ctx.flags, 'file')
      const uploadId = getFlag(ctx.flags, 'upload-id')
      const resourceId = getSourceResourceIdFlag(ctx.flags)
      if (
        [filePath, uploadId, resourceId].filter(value => value != null)
          .length !== 1 ||
        sourceInputCount(ctx.flags) > (uploadId == null ? 1 : 0)
      )
        throw new Error(
          'Provide exactly one of --file, --resource-id, or --upload-id',
        )
      print(
        await importCanvasAssetWithState({
          client: ctx.client,
          baseUrl: ctx.client.baseUrl,
          ownerId: canvas.ownerId,
          canvasId: canvas.id,
          stateDir: stateOptions(ctx).stateDir,
          name: getFlag(ctx.flags, 'name'),
          ...(filePath != null
            ? {
                filePath: assertFlagHasValue(filePath, '--file <image>'),
                contentType: getContentTypeFlag(ctx.flags),
              }
            : {
                source:
                  uploadId != null
                    ? {
                        uploadId: assertFlagHasValue(
                          uploadId,
                          '--upload-id <id>',
                        ),
                      }
                    : {
                        resourceId: assertFlagHasValue(
                          resourceId!,
                          '--resource-id <id>',
                        ),
                      },
              }),
        }),
      )
    } else {
      print(
        await writeCanvasComparison({
          client: ctx.client,
          canvasId: canvas.id,
          sourceId: requireFlag(ctx.flags, 'source-id'),
          assetId: requireFlag(ctx.flags, 'asset-id'),
          out: requireFlag(ctx.flags, 'out'),
          title: getFlag(ctx.flags, 'title'),
        }),
      )
    }
    return
  }
  if (subcommand === 'list') {
    print(await ctx.client.v2.listCanvases(pageOptions(ctx.flags)))
    return
  }
  const capabilities = await ctx.client.v2.getCapabilities()
  if (capabilities.executionContext.status !== 'available')
    throw new Error('Canvas execution history unavailable')
  const scope = {
    ...stateOptions(ctx),
    baseUrl: ctx.client.baseUrl,
    ownerId: capabilities.ownerId,
  }
  if (subcommand === 'create') {
    const canvas = await ctx.client.v2.createCanvas(
      {name: getFlag(ctx.flags, 'name') ?? 'Agent canvas'},
      {idempotencyKey: getFlag(ctx.flags, 'operation-id') ?? randomUUID()},
    )
    await saveCanvasSelection(scope, canvas.id)
    print(canvas)
    return
  }
  if (!['get', 'use', 'open'].includes(subcommand ?? ''))
    throw new Error('Use canvas create|list|get|use|open')
  const id =
    positionals[2] == null
      ? selectedCanvasId(ctx.flags)
      : Number(positionals[2])
  const canvas = await resolveCanvasSelection({
    ...scope,
    canvasId: id,
    create: false,
  })
  if (subcommand === 'use') await saveCanvasSelection(scope, canvas.id)
  if (subcommand === 'open' && stdout.isTTY) {
    const url = canvas.url
    await execFileAsync(
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'rundll32'
          : 'xdg-open',
      process.platform === 'win32'
        ? ['url.dll,FileProtocolHandler', url]
        : [url],
    )
  }
  print(canvas)
}
const commandLanguage = async (
  subcommand: string | undefined,
  ctx: CommandContext,
) => {
  if (subcommand !== 'text' && subcommand !== 'vision')
    throw new Error(
      'Use language text|vision --input-json @<file> --operation-id <uuid>',
    )
  const input = await readJsonArgument(
    requireFlag(ctx.flags, 'input-json'),
    '--input-json',
  )
  const operationId = requireFlag(ctx.flags, 'operation-id')
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      operationId,
    )
  )
    throw new Error(
      '--operation-id must be a UUID; reuse the same ID and input after an uncertain response',
    )
  activeExecution.operationId = operationId
  const result =
    subcommand === 'text'
      ? await ctx.client.v2.languageText(input as LanguageRequest, {
          idempotencyKey: operationId,
        })
      : await ctx.client.v2.languageVision(input as VisionRequest, {
          idempotencyKey: operationId,
        })
  const out = getFlag(ctx.flags, 'out')
  if (out) {
    await mkdir(dirname(resolve(out)), {recursive: true})
    await writeFile(resolve(out), JSON.stringify(result, null, 2) + '\n', {
      mode: 0o600,
    })
  }
  print(result)
}

const commandMoodboard = async (
  subcommand: string | undefined,
  positionals: string[],
  ctx: CommandContext,
) => {
  if (subcommand === 'list') {
    print(await ctx.client.v2.listMoodboards(pageOptions(ctx.flags)))
    return
  }
  if (subcommand === 'create' || subcommand === 'update') {
    const input = (await readJsonArgument(
      requireFlag(ctx.flags, 'input-json'),
      '--input-json',
    )) as MoodboardInput
    if (subcommand === 'update') {
      print(
        await ctx.client.v2.updateMoodboard(
          requirePositional(positionals, 2, 'board-id'),
          input,
        ),
      )
      return
    }
    const {ownerId} = await ctx.client.v2.getCapabilities()
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({baseUrl: ctx.client.baseUrl, ownerId, input}))
      .digest('hex')
    const clientOperationId =
      getFlag(ctx.flags, 'operation-id') ??
      `${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-4${fingerprint.slice(13, 16)}-8${fingerprint.slice(17, 20)}-${fingerprint.slice(20, 32)}`
    activeExecution.operationId = clientOperationId
    print(await ctx.client.v2.createMoodboard({...input, clientOperationId}))
    return
  }
  const boardId = requirePositional(positionals, 2, 'board-id')
  if (subcommand === 'get') {
    print(await ctx.client.v2.getMoodboard(boardId))
    return
  }
  if (subcommand === 'archive') {
    print(await ctx.client.v2.archiveMoodboard(boardId))
    return
  }
  if (subcommand !== 'analyze')
    throw new Error('Use moodboard create|list|get|update|archive|analyze')
  const timeoutMs = parsePositiveIntegerFlag(ctx.flags, 'timeout-ms', 900000)
  const intervalMs = parsePositiveIntegerFlag(ctx.flags, 'interval-ms', 5000)
  const deadline = Date.now() + timeoutMs
  let revision = await ctx.client.v2.analyzeMoodboard(
    boardId,
    {revisionId: getFlag(ctx.flags, 'revision')},
    {signal: AbortSignal.timeout(timeoutMs)},
  )
  while (hasFlag(ctx.flags, 'wait') && revision.status === 'analyzing') {
    stderr.write(
      `[moodboard] ${boardId} revision=${revision.id} analyzing job=${revision.analysisJobId ?? 'pending'}\n`,
    )
    if (Date.now() >= deadline)
      throw new Error(
        `Moodboard analysis timeout; resume with moodboard get ${boardId}`,
      )
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())))
    if (Date.now() >= deadline)
      throw new Error(
        `Moodboard analysis timeout; resume with moodboard get ${boardId}`,
      )
    const board = await ctx.client.v2.getMoodboard(boardId, {
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    })
    if (board.currentRevision?.id !== revision.id)
      throw new Error(
        'Moodboard revision changed while waiting; inspect the board before generating',
      )
    revision = board.currentRevision
  }
  print(revision)
  if (revision.status === 'failed') process.exitCode = 1
}

const commandGraph = async (
  subcommand: string | undefined,
  ctx: CommandContext,
) => {
  const graphId = getFlag(ctx.flags, 'graph')
  if (getFlag(ctx.flags, 'source') && !graphId)
    throw new Error('--source requires --graph')
  if (graphId && getFlag(ctx.flags, 'canvas'))
    throw new Error('cannot combine --graph and --canvas')
  if (subcommand === 'list') {
    print(await ctx.client.v2.listGraphs(pageOptions(ctx.flags)))
    return
  }
  if (!['show', 'lineage', 'export'].includes(subcommand ?? ''))
    throw new Error('Use graph list|show|lineage|export')

  const direction = getFlag(ctx.flags, 'direction') ?? 'both'
  if (!['ancestors', 'descendants', 'both'].includes(direction))
    throw new Error('--direction must be ancestors, descendants, or both')
  const artifactId =
    subcommand === 'lineage'
      ? requireFlag(ctx.flags, 'artifact')
      : getFlag(ctx.flags, 'artifact')
  const graph = graphId
    ? await ctx.client.v2.getGraph(graphId, {
        source: parseEnumFlag(ctx.flags, 'source', ['generated', 'upload'] as const),
        artifactId,
        direction: direction as 'ancestors' | 'descendants' | 'both',
        depth: parsePositiveIntegerFlag(ctx.flags, 'depth', 5),
      })
    : await (async () => {
        const {canvas} = await canvasForRead(ctx)
        return ctx.client.v2.getCanvasGraph(canvas.id, {
          artifactId,
          direction: direction as 'ancestors' | 'descendants' | 'both',
          depth: parsePositiveIntegerFlag(ctx.flags, 'depth', 5),
        })
      })()
  if (
    (subcommand === 'export' || getFlag(ctx.flags, 'out')) &&
    graph.truncated &&
    !hasFlag(ctx.flags, 'allow-truncated')
  )
    throw new Error(
      'Graph exceeds export bounds; narrow with --artifact or explicitly use --allow-truncated',
    )
  const out = getFlag(ctx.flags, 'out')
  if (out) {
    await writeFile(resolve(out), JSON.stringify(graph, null, 2) + '\n', {
      mode: 0o600,
    })
    print({
      path: resolve(out),
      revision: graph.revision,
      truncated: graph.truncated,
    })
  } else print(graph)
}
const commandEvaluations = async (
  subcommand: string | undefined,
  positionals: string[],
  ctx: CommandContext,
) => {
  if (subcommand === 'get') {
    print(
      await ctx.client.v2.getEvaluation(
        requirePositional(positionals, 2, 'evaluation-id'),
      ),
    )
    return
  }
  const {canvas} = await canvasForRead(ctx)
  if (subcommand === 'list') {
    print(
      await ctx.client.v2.listEvaluations({
        ...pageOptions(ctx.flags),
        canvasId: canvas.id,
        artifactId: getFlag(ctx.flags, 'artifact'),
      }),
    )
    return
  }
  if (subcommand !== 'submit')
    throw new Error('Use evaluations submit|list|get')
  const reportArg = requireFlag(ctx.flags, 'report')
  const report = await readJsonArgument(
    reportArg.startsWith('{') || reportArg.startsWith('@')
      ? reportArg
      : `@${reportArg}`,
    '--report',
  )
  const clientOperationId = getFlag(ctx.flags, 'operation-id') ?? randomUUID()
  activeExecution.operationId = clientOperationId
  const evaluation = await ctx.client.v2.submitEvaluation(
    {
      canvasId: canvas.id,
      clientOperationId,
      artifactId: requireFlag(ctx.flags, 'artifact'),
      runId: getFlag(ctx.flags, 'run'),
      referenceAssetIds: [
        ...new Set([
          ...getFlagValues(ctx.flags, 'reference'),
          ...(Array.isArray(report.referenceAssetIds)
            ? report.referenceAssetIds.filter(
                (id): id is string => typeof id === 'string',
              )
            : []),
        ]),
      ],
      evaluator: {
        name: getFlag(ctx.flags, 'agent') ?? 'external-agent',
        version: getFlag(ctx.flags, 'evaluator-version'),
      },
      report: report as EvaluationReport,
    },
    {idempotencyKey: clientOperationId},
  )
  print(evaluation)
  if (hasFlag(ctx.flags, 'require-pass'))
    process.exitCode =
      evaluation.report.verdict === 'pass'
        ? 0
        : evaluation.report.verdict === 'fail'
          ? 1
          : 3
}

/**
 * `assethub runs upload <path>` — push a local artifact-graph run folder to
 * Production Control.
 *
 * The wire format is `ag.registry.v1`, identical to what the Cloudflare
 * ag-registry accepts, so the same folder can go to either destination without
 * conversion. See src/runsUpload/ for the plan/transport split, and
 * src/runsUpload/controlEndpoints.ts for every path and size limit.
 */
const commandRuns = async (
  subcommand: string | undefined,
  positionals: string[],
  ctx: CommandContext,
): Promise<void> => {
  if (subcommand === 'list') {
    const {canvas} = await canvasForRead(ctx)
    print(await ctx.client.v2.listCanvasRuns(canvas.id, pageOptions(ctx.flags)))
    return
  }
  if (subcommand === 'get' || subcommand === 'watch') {
    const id = requirePositional(positionals, 2, 'run-id')
    const execution =
      subcommand === 'get'
        ? await ctx.client.v2.getRun(id)
        : await waitForExecution(ctx.client, id, watchOptions(ctx.flags))
    print({execution})
    process.exitCode = executionExitCode(execution)
    return
  }
  if (subcommand === 'resume') {
    const batch = await resumeNodeMeshBatch({
      ...stateOptions(ctx),
      operationId: requirePositional(positionals, 2, 'operation-id'),
    })
    if (batch) {
      await printNodeMeshBatch(ctx, batch)
      return
    }
    const result = await resumeRecorded({
      ...stateOptions(ctx),
      operationId: requirePositional(positionals, 2, 'operation-id'),
    })
    await printRecorded(ctx, result)
    return
  }
  const args = parseRunsUploadArgs(subcommand, positionals, ctx.flags)

  const folder = await readGraphFolder(resolve(args.folderPath))
  const plan = await buildRunUploadPlan({
    folder,
    graphId: args.graphId,
    streamId: args.streamId,
    rev: args.rev,
    description: args.description,
    tags: args.tags,
  })
  for (const warning of plan.warnings) {
    stderr.write(`[warn] ${warning}\n`)
  }

  const summary = runsUploadSummary(folder.path, plan)

  // --dry-run stops here on purpose: everything above is the validation a
  // corrupt run folder fails, so this is how you find out before production
  // sees it.
  if (args.dryRun) {
    print(runsUploadDryRunReport(summary, plan, ctx.auth.baseUrl))
    return
  }

  const result = await uploadRun({
    plan,
    baseUrl: ctx.auth.baseUrl,
    apiKey: ctx.auth.apiKey,
    workspaceId: ctx.auth.workspaceId,
    skipRegister: args.skipRegister,
    onProgress: event => {
      if (event.kind === 'register') {
        stderr.write(`[upload] register graph=${event.graphId}\n`)
        return
      }
      if (event.kind === 'blob') {
        stderr.write(
          `[upload] blob ${event.index + 1}/${event.total} ${event.status} ` +
            `${event.blob.name} (${formatBytes(event.blob.size)})\n`,
        )
        return
      }
      stderr.write(
        `[upload] snapshot graph=${event.graphId} rev=${event.rev}\n`,
      )
    },
  })

  print({...summary, ...result})
}

export type RunsUploadArgs = {
  folderPath: string
  graphId: string | undefined
  streamId: string | undefined
  rev: number | undefined
  description: string
  tags: string[]
  dryRun: boolean
  skipRegister: boolean
}

/**
 * Everything `runs upload` decides from argv, split out from the command so the
 * subcommand routing and flag handling are testable without a filesystem, an
 * API key, or a network.
 */
export const parseRunsUploadArgs = (
  subcommand: string | undefined,
  positionals: string[],
  flags: Flags,
): RunsUploadArgs => {
  if (subcommand !== 'upload') {
    throw new Error('Unknown runs command. Use "runs upload <path>".')
  }
  const folderPath = positionals[2]
  if (folderPath == null || folderPath.trim().length === 0) {
    throw new Error(
      'assethub runs upload needs the path to a run folder (the directory holding manifest.json, nodes.jsonl and edges.jsonl).',
    )
  }
  return {
    folderPath,
    graphId: getFlag(flags, 'graph-id'),
    streamId: getFlag(flags, 'stream-id'),
    rev: parseNonNegativeIntegerFlag(flags, 'rev'),
    description: getFlag(flags, 'description') ?? '',
    tags: getFlagValues(flags, 'tag'),
    dryRun: hasFlag(flags, 'dry-run'),
    skipRegister: hasFlag(flags, 'skip-register'),
  }
}

type RunUploadPlanLike = Pick<
  Awaited<ReturnType<typeof buildRunUploadPlan>>,
  | 'graphId'
  | 'streamId'
  | 'rev'
  | 'graphHash'
  | 'counts'
  | 'sizes'
  | 'blobs'
  | 'warnings'
>

export const runsUploadSummary = (
  runFolder: string,
  plan: RunUploadPlanLike,
) => ({
  runFolder,
  graphId: plan.graphId,
  streamId: plan.streamId,
  rev: plan.rev,
  graphHash: plan.graphHash,
  counts: plan.counts,
  snapshotSize: formatBytes(plan.sizes.pushBytes),
  blobBytes: formatBytes(plan.counts.blobBytes),
})

export const runsUploadDryRunReport = (
  summary: ReturnType<typeof runsUploadSummary>,
  plan: RunUploadPlanLike,
  baseUrl: string,
) => ({
  dryRun: true,
  ...summary,
  warnings: plan.warnings,
  blobs: plan.blobs.map(blob => ({
    blobKey: blob.blobKey,
    name: blob.name,
    mime: blob.mime,
    size: blob.size,
  })),
  wouldUpload: `${plan.blobs.length} blob(s) then 1 snapshot to ${baseUrl}`,
})

const parseNonNegativeIntegerFlag = (
  flags: Flags,
  name: string,
): number | undefined => {
  const raw = getFlag(flags, name)
  if (raw == null || raw === 'true') {
    return undefined
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`)
  }
  return parsed
}

const run = async (): Promise<void> => {
  const parsed = parseArgs(argv.slice(2))
  if (hasFlag(parsed.flags, 'version')) {
    stdout.write(`${await cliVersion()}\n`)
    return
  }
  if (hasFlag(parsed.flags, 'help') || parsed.positionals.length === 0) {
    stdout.write(usage)
    return
  }

  const [command, subcommand] = parsed.positionals
  if (command === 'mcp' && subcommand === 'tools') {
    stderr.write('Discovering AssetHub MCP tools…\n')
    const report = await diagnose({
      resolveAuth: async () => {
        if (!hasFlag(parsed.flags, 'account')) return resolveAuth(parsed.flags)
        const auth = await workspaceAuth(parsed.flags)
        return {apiKey: auth.accessToken, workspaceMfaToken: auth.workspaceMfaToken, baseUrl: auth.baseUrl, profile: auth.profile, source: 'user'}
      },
      account: hasFlag(parsed.flags, 'account'),
      includeMcp: true,
      includeTools: true,
      timeoutMs: parsePositiveIntegerFlag(parsed.flags, 'timeout-ms', 15000),
    })
    if (!report.ok) {
      print(report)
      process.exitCode = 2
      return
    }
    const check = report.checks.find(check => check.name === 'mcp')
    const tools = check && 'tools' in check ? check.tools ?? [] : []
    const name = parsed.positionals[2]
    if (name) {
      const tool = tools.find(tool => tool.name === name)
      if (!tool) throw new Error(`Unknown MCP tool: ${name}. Use mcp tools to list available names.`)
      print({tool})
    } else {
      print({total: tools.length, tools: tools.map(({name, title, annotations}) => ({name, title, annotations}))})
    }
    return
  }
  if (command === 'mcp') {
    if (subcommand !== 'config')
      throw new Error('Use mcp tools [tool-name] or mcp config --client cursor|codex')
    const config = await readAuthConfig(getConfigPath(parsed.flags))
    const explicitProfile = getFlag(parsed.flags, 'profile')
    const stored = config.profiles?.[explicitProfile ?? config.defaultProfile ?? defaultProfileName]
    if (explicitProfile && !stored) throw new Error('Selected profile does not exist')
    const selected = explicitProfile || stored?.workspaceId || isPersonalProfile(stored)
    const baseUrl = getFlag(parsed.flags, 'base-url') ??
      (selected ? stored?.baseUrl : env.ASSETHUB_API_BASE_URL ?? stored?.baseUrl) ?? defaultBaseUrl
    const workspaceId = getFlag(parsed.flags, 'workspace') ??
      (stored && new URL(baseUrl).origin === new URL(stored.baseUrl).origin ? stored.workspaceId : undefined)
    stdout.write(
      mcpConfig(
        requireFlag(parsed.flags, 'client'),
        baseUrl,
        hasFlag(parsed.flags, 'account'),
        workspaceId,
      ),
    )
    return
  }
  if (command === 'doctor') {
    stderr.write('Checking AssetHub connection…\n')
    const report = await diagnose({
      resolveAuth: () => resolveAuth(parsed.flags),
      includeMcp: hasFlag(parsed.flags, 'mcp'),
      timeoutMs: parsePositiveIntegerFlag(parsed.flags, 'timeout-ms', 15000),
    })
    print(report)
    if (!report.ok) process.exitCode = 2
    return
  }
  if (command === 'project') {
    if (subcommand !== 'ingest')
      throw new Error('Use project ingest <source-dir> --out-dir <directory>')
    const result = await ingestProjectSources({
      sourceDir: requirePositional(parsed.positionals, 2, 'source-dir'),
      outDir: requireFlag(parsed.flags, 'out-dir'),
      excludedDirectories: getFlagValues(parsed.flags, 'exclude-dir').map(
        value => assertFlagHasValue(value, '--exclude-dir <relative-path>'),
      ),
      onProgress: message => {
        stderr.write(`[ingest] ${message}\n`)
      },
    })
    print(result)
    if (result.status !== 'complete') process.exitCode = 3
    return
  }
  if (command === 'workspace') {
    if (['list', 'get', 'create', 'use', 'members', 'invite', 'set-role', 'remove-member'].includes(subcommand ?? '')) {
      await commandWorkspace(subcommand, parsed.positionals, parsed.flags)
      return
    }
    if (!hasFlag(parsed.flags, 'internal')) {
      throw new Error(
        'Workspace operations currently require --internal and the AssetHub monorepo with its existing Infisical environment.',
      )
    }
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const script = join(root, 'apps/frontend/scripts/assethub-workspace.ts')
    await readFile(script).catch(() => {
      throw new Error(
        'Internal workspace, moodboard and context operations require the AssetHub monorepo checkout and its native application dependencies.',
      )
    })
    await new Promise<void>((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          script,
          ...argv.slice(3).filter(arg => arg !== '--internal'),
        ],
        {
          cwd: root,
          env: {
            ...env,
            TSX_TSCONFIG_PATH: join(root, 'apps/frontend/tsconfig.json'),
          },
          stdio: 'inherit',
        },
      )
      child.once('error', reject)
      child.once('exit', code =>
        code === 0
          ? done()
          : reject(
              new Error(
                `Internal workspace operation exited with ${code ?? 'a signal'}`,
              ),
            ),
      )
    })
    return
  }
  if (command === 'auth') {
    await commandAuth(subcommand, parsed.flags)
    return
  }

  if (command === 'autopilot') {
    throw new Error(
      'The experimental autopilot demo requires the AssetHub monorepo with @assethub/autopilot-core installed. Standalone project workflow commands are available without it.',
    )
  }

  const ctx = await createContext(parsed.flags, argv.slice(2))
  switch (command) {
    case 'composer':
      await commandComposer(subcommand, ctx)
      return
    case 'language':
      await commandLanguage(subcommand, ctx)
      return
    case 'moodboard':
      await commandMoodboard(subcommand, parsed.positionals, ctx)
      return
    case 'canvas':
      await commandCanvas(subcommand, parsed.positionals, ctx)
      return
    case 'graph':
      await commandGraph(subcommand, ctx)
      return
    case 'evaluations':
      await commandEvaluations(subcommand, parsed.positionals, ctx)
      return
    case 'evaluate':
      if (subcommand !== 'list')
        throw new Error(
          'Server evaluators are capability-gated. Use evaluate list, or evaluations submit for external agent reports.',
        )
      print((await ctx.client.v2.getCapabilities()).evaluators)
      return
    case 'capabilities':
      print(await ctx.client.v2.getCapabilities())
      return
    case 'models':
      await commandModels(subcommand, parsed.positionals, ctx)
      return
    case 'files':
      await commandFiles(subcommand, parsed.positionals, ctx)
      return
    case 'source':
      await commandSource(subcommand, ctx)
      return
    case 'image':
      await commandImage(subcommand, ctx)
      return
    case 'mesh':
      await commandMesh(subcommand, parsed.positionals, ctx)
      return
    case 'rig':
      await commandRig(subcommand, ctx)
      return
    case 'animate':
      await commandAnimate(subcommand, ctx)
      return
    case 'jobs':
      await commandJobs(subcommand, parsed.positionals, ctx)
      return
    case 'production':
      await commandProduction(subcommand, parsed.positionals, ctx)
      return
    case 'runs':
      await commandRuns(subcommand, parsed.positionals, ctx)
      return
    case 'parts':
      await commandParts(subcommand, ctx)
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

const isMainModule = (() => {
  const entry = argv[1]
  if (entry == null) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry)
  } catch {
    return false
  }
})()

if (isMainModule) {
  process.once('SIGINT', () => {
    print({
      error: {
        code: 'INTERRUPTED',
        message: 'Client interrupted; server execution continues',
      },
      ...activeExecution,
    })
    exit(130)
  })
  run().catch((error: unknown) => {
    if (error instanceof AssetHubApiError) {
      stderr.write(
        `AssetHub API error [${error.status}] ${error.code}: ${error.message}\n`,
      )
    } else if (error instanceof Error) {
      stderr.write(`${error.message}\n`)
    } else {
      stderr.write(`${String(error)}\n`)
    }
    print({
      error: {
        code:
          error instanceof AssetHubApiError ||
          error instanceof WorkspaceClientError
            ? error.code
            : error instanceof CliExecutionError && error.exitCode === 3
              ? 'WAIT_TIMEOUT'
              : 'CLI_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
      runId:
        error instanceof CliExecutionError
          ? error.runId
          : activeExecution.runId,
      operationId:
        error instanceof CliExecutionError
          ? error.operationId
          : activeExecution.operationId,
      execution:
        error instanceof CliExecutionError
          ? error.execution
          : activeExecution.execution,
    })
    exit(
      error instanceof CliExecutionError
        ? error.exitCode
        : error instanceof AssetHubApiError &&
            error.status >= 500 &&
            error.code !== 'CANVAS_EXECUTION_UNAVAILABLE' &&
            error.code !== 'EVALUATOR_UNAVAILABLE'
          ? 1
          : 2,
    )
  })
}
