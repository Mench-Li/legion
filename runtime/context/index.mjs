// runtime/context/index.mjs
// ============================================================================
// 上下文装配的聚合出口（PRT-407）
//
// 与 `runtime/contracts/index.mjs` 同一约定：外部只见本文件，
// 不直接深入子模块。
//
// 这个文件的存在本身是有意义的：一个只有实现文件、没有任何出口的模块，
// 在用户侧与"不存在"完全一样（本项目已经在 PRT-504 上栽过一次——
// 实现、套件、文档俱全，而没有任何调用方）。
// ============================================================================

export {
  ASSEMBLY_CODES,
  AssemblyError,
  assembleContext,
  describeAssembly,
} from './assembler.mjs'

// PRT-408：来源清单
export {
  INVENTORY_OUTCOMES,
  createSourceInventory,
  createSourceInventoryEntry,
} from '../contracts/context.mjs'

// PRT-406：skill / document 的可信性——`trustForOrigin` 是"逐条区分"的唯一出处
export {
  collectCandidates,
  defaultTrustForType,
  publishedSources,
  trustForOrigin,
  trustOfPublishedItem,
} from './sources.mjs'

// PRT-413：精确 tokenizer 的**接入点**（词表由使用者提供，见 tokenizer-registry.mjs）
export {
  BPE_ARTIFACT_FIELDS,
  bytesToUnicode,
  createBpeTokenizer,
  exactTokenizerFromArtifact,
  fromByteLevel,
  parseTokenizerArtifact,
  toByteLevel,
} from './bpe.mjs'
export {
  TOKENIZER_ARTIFACT_SUFFIX,
  TOKENIZER_LOAD_ERRORS,
  TokenizerLoadError,
  createLazyTokenizerRegistry,
  loadTokenizerRegistry,
} from './tokenizer-registry.mjs'
