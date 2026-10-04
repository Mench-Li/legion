// product/update/index.mjs
// ============================================================================
// 自动更新的公开面 —— 依据 docs/superpowers/specs/2026-10-02-legion-desktop-auto-update-design.md
//
// 这些模块按设计里的**四个层次**划分，各自解决一类问题。放在一个 barrel
// 里不是"顺手导出"，而是为了让人一眼看到边界：
//
//   ┌ 信任层（§5）   canonical → envelope → keys/信任表
//   │    回答："这份清单是不是发布方签的，且没被改写？"
//   ├ 协议层（§4/§5）host → release → feed → semver
//   │    回答："发行的形状对不对，我能不能升上去？"
//   ├ 传输层（§6）   transport → schedule → cache
//   │    回答："什么时候取、取到哪儿、失败怎么办？"
//   └ 事务层（§7/§8）state → client → journal → barrier → credential → install → helper
//        回答："谁在什么时候动程序，崩了之后回到哪里？"
//
// ## 这个 barrel 不导出什么，以及为什么
//
//   · **不导出**任何"跳过验签"的开关。设计 §5 把信任根定死了，而一个
//     `allowUnsigned` 参数会在第一次部署出问题时被用上，然后再也没人拿掉。
//   · **不导出** helper 的注入点。`helper.mjs` 的 `effects` 是给测试用的，
//     生产路径由 `runHelperProcess` 用默认实现。
//   · **不导出** `legacyPrecedence`。它是 `semver.mjs` 里用于**量化修正**
//     的对照实现（见 `precedenceDifferences`），生产路径不得调用。
// ============================================================================

// —— 信任层 ——
export {
  CANONICAL_CODES, CANONICAL_CHECKED, CANONICAL_VECTORS, canonicalBytes, canonicalJson,
  DEFAULT_MAX_DEPTH, DEFAULT_MAX_JSON_BYTES, digestOf, isSha256Hex, parseJsonStrict, selfCheckCanonical, sha256Hex,
} from './canonical.mjs'
export {
  applyTrustUpdate, checkValidityWindow, createTrustStore, ED25519_SIGNATURE_BYTES, ENVELOPE_CHECKED,
  ENVELOPE_CODES, ENVELOPE_FORMATS, ENVELOPE_PREFIX, ENVELOPE_VERDICTS, generateReleaseKeyPair,
  keyFingerprint, parseIsoMs, selectKey, selfCheckEnvelope, serializeEnvelope, signEnvelope, signTrustUpdate,
  signedBytes, verifyEnvelope,
} from './envelope.mjs'

// —— 协议层 ——
export {
  HOST_CHECKED, HOST_CODES, FEED_CACHE_CONTROL, RELEASE_CACHE_CONTROL, artifactUrl, createHostConfig,
  evaluateRedirect, evaluateResponse, expectedCacheControl, feedRelativePath, feedUrl, isSameOrigin,
  PLATFORM_TOKENS, platformToken, releaseManifestRelativePath, releaseManifestUrl, requestHeaders, selfCheckHost,
} from './host.mjs'
export {
  ARTIFACT_KINDS, KNOWN_PLATFORMS, RELEASE_CHECKED, RELEASE_CODES, RELEASE_FORMAT, ROLLBACK_POLICIES,
  artifactFromBytes, buildRelease, identityLabel, releaseIdentity, sameIdentity, sampleRelease, selfCheckRelease,
  validateRelativePath, validateRelease,
} from './release.mjs'
export {
  FEED_CHECKED, FEED_CODES, FEED_FIELDS, FEED_FORMAT, SEQUENCE_STORE_FORMAT, buildFeedPayload, createSequenceStore,
  emptySequenceState, judgeSequence, recordSequence, selectCandidate, selfCheckFeed, sequenceStoreFor,
  sortCandidatesDescending, validateFeedPayload,
} from './feed.mjs'
export {
  SEMVER_CHECKED, SEMVER_CODES, SEMVER_FIXTURES, compareSemver, isNewer, isSameCoreVersion, isSemver,
  isSupportedFrom, parseSemver, precedenceDifferences, selfCheckSemver, sortSemver, tryCompareSemver,
} from './semver.mjs'

// —— 传输层 ——
export {
  MAX_ARTIFACT_BYTES, MAX_MANIFEST_BYTES, IDLE_TIMEOUT_MS, MANIFEST_TIMEOUT_MS, TRANSPORT_CHECKED,
  TRANSPORT_CODES, commitDownload, createFetchStub, createTransport, discardDownload, hashFileOnDisk,
  selfCheckTransport, sizeOfFile,
} from './transport.mjs'
export {
  CHECK_OUTCOMES, CHECK_POLICY_DEFAULTS, CHECK_TRIGGERS, SCHEDULE_CHECKED, createCheckScheduler,
  describeBackoff, jitterSeed, planNextCheck, planResumeCatchUp, selfCheckSchedule, withJitter,
} from './schedule.mjs'
export { CACHE_CHECKED, CACHE_CODES, PART_SUFFIX, cacheRelativePath, createDownloadCache, selfCheckCache } from './cache.mjs'
export {
  BOMB_POLICY, EXECUTABLE_EXTENSIONS, EXTRACT_CHECKED, EXTRACT_CODES, MAX_CLOSURE_BYTES, SUPPORTED_METHODS,
  extractArchive, isInside, looksExecutable, parseClosureBytes, planExtraction, readCentralDirectory,
  resolveClosureEntry, selfCheckExtract, validateEntryName, verifyExtractedTree,
} from './extract.mjs'
export {
  CLOSURE_CHECKED, CLOSURE_CODES, CLOSURE_ENTRY_NAME, CLOSURE_PROTOCOL, MAX_CLOSURE_BYTES as MAX_CLOSURE_FILE_BYTES,
  buildClosure, closureDigest, closureFromDirectory, parseClosure, selfCheckClosure, serializeClosure,
  toClosurePath, validateClosure,
} from './closure.mjs'
export {
  DEFAULT_DEFLATE_LEVEL, ZIP_CHECKED, ZIP_CODES, ZIP_METHODS, buildZip, crc32Of, dosDateTime, selfCheckZip,
  shouldCompress,
} from './zip.mjs'

// —— 事务层 ——
export {
  PROTECTED_STATES, RETRYABLE_STATES, STATE_CHECKED, STATE_LABELS, TERMINAL_STATES, UPDATE_CHAIN,
  UPDATE_EVENTS, UPDATE_OFFCHAIN, UPDATE_STATES, canCancelDownload, canDownload, canInstall, selfCheckState, transition,
} from './state.mjs'
export { CHECK_OUTCOMES as CLIENT_CHECK_OUTCOMES, MAX_NOTES_BYTES, createUpdateClient, decodePlainText } from './client.mjs'
export {
  ACTIVE_FILENAME, JOURNAL_CHECKED, JOURNAL_CODES, JOURNAL_FILENAME, JOURNAL_FORMAT, IRREVERSIBLE_ACTIONS,
  TERMINAL_PHASES, TRANSACTION_PHASES, UPDATE_STATE_DIRNAME, activePath, clearActive, createJournal, journalPath,
  planRecovery, readActive, readJournal, selfCheckJournal, updateStateDir,
} from './journal.mjs'
export {
  BARRIER_CHECKED, BARRIER_CODES, BARRIER_FILENAME, BARRIER_FORMAT, DEFAULT_DRAIN_TIMEOUT_MS, acquireBarrier,
  barrierPath, canAcceptWrites, readBarrier, releaseBarrier, selfCheckBarrier, startupGate,
} from './barrier.mjs'
export {
  CREDENTIAL_CHECKED, CREDENTIAL_CODES, CREDENTIAL_FIELDS, CREDENTIAL_FILENAME, DEFAULT_CREDENTIAL_TTL_MS,
  consumeCredential, credentialPath, destroyCredential, isOutsideSwitchTarget, issueCredential, secretPath,
  selfCheckCredential, verifyProgramDigest,
} from './credential.mjs'
export {
  HELPER_VERDICTS, INSTALL_CHECKED, INSTALL_CODES, INSTALL_ORCHESTRATOR, INSTALL_STEPS, INSTALL_VERDICTS,
  clearHelperReport, finalVerdict, helperDataSafety, helperReportPath, newTransactionId, readHelperReport,
  runInstallTransaction, selfCheckInstall, writeHelperReport,
} from './install.mjs'
export {
  HEALTH_CODES, HEALTH_CHECKED, HEALTH_LIMITS, HEALTH_PROTOCOL, LOOPBACK_HOSTS, checkUrl, compareSubset,
  createHealthProbe, expandStrict, healthSpecFromProcesses, selfCheckHealth, validateHealthSpec,
} from './health.mjs'
export {
  HELPER_CHECKED, HELPER_CODES, HELPER_PROTOCOL, clearTransactionFile, runHelper, runHelperProcess,
  selfCheckHelper, validateInvocation, writeTransactionFile,
} from './helper.mjs'

// —— 配置与文案 ——
export {
  CONFIG_CHECKED, CONFIG_CODES, UPDATE_CONFIG_FILENAME, UPDATE_TRUST_FILENAME, buildUpdateConfig,
  loadTrustStore, loadUpdateConfig, selfCheckConfig,
} from './config.mjs'
export {
  ERROR_TEXT, ERRORS_CHECKED, RETRYABLE_CODES, UPDATE_CODES_CLIENT, describeError, isRetryable, redact,
  selfCheckErrors,
} from './errors.mjs'

/**
 * 各层的装载期自检汇总。任何一层不为 ok，都说明**它自己的判据**不自洽。
 *
 * 这个汇总函数存在的意义是让"某人放宽了某条拒绝"有一个单一的读取点——
 * `modules.test.mjs` 正是逐个读这些结论并要求全绿。
 */
export async function selfCheckAll() {
  const layer = async (name, mod) => {
    const key = Object.keys(mod).find((k) => k.endsWith('_CHECKED'))
    return { layer: name, ok: mod[key]?.ok === true, problems: mod[key]?.problems ?? [] }
  }
  const results = await Promise.all([
    layer('canonical', await import('./canonical.mjs')),
    layer('envelope', await import('./envelope.mjs')),
    layer('semver', await import('./semver.mjs')),
    layer('release', await import('./release.mjs')),
    layer('feed', await import('./feed.mjs')),
    layer('host', await import('./host.mjs')),
    layer('transport', await import('./transport.mjs')),
    layer('schedule', await import('./schedule.mjs')),
    layer('cache', await import('./cache.mjs')),
    layer('extract', await import('./extract.mjs')),
    layer('closure', await import('./closure.mjs')),
    layer('zip', await import('./zip.mjs')),
    layer('health', await import('./health.mjs')),
    layer('platform-build', await import('./platform-build.mjs')),
    layer('state', await import('./state.mjs')),
    layer('config', await import('./config.mjs')),
    layer('errors', await import('./errors.mjs')),
    layer('journal', await import('./journal.mjs')),
    layer('barrier', await import('./barrier.mjs')),
    layer('credential', await import('./credential.mjs')),
    layer('install', await import('./install.mjs')),
    layer('helper', await import('./helper.mjs')),
  ])
  return Object.freeze({
    ok: results.every((item) => item.ok),
    results: Object.freeze(results.map((item) => Object.freeze({ ...item, problems: Object.freeze(item.problems) }))),
  })
}

/** 模块布局（文档与测试用）。 */
export const UPDATE_MODULES = Object.freeze({
  trust: Object.freeze(['./canonical.mjs', './envelope.mjs']),
  protocol: Object.freeze(['./host.mjs', './release.mjs', './feed.mjs', './semver.mjs']),
  transport: Object.freeze(['./transport.mjs', './schedule.mjs', './cache.mjs', './extract.mjs']),
  transaction: Object.freeze([
    './state.mjs', './client.mjs', './journal.mjs', './barrier.mjs',
    './credential.mjs', './install.mjs', './health.mjs', './helper.mjs',
  ]),
  config: Object.freeze(['./config.mjs', './errors.mjs']),
})

/** 依据的设计文档（相对仓库根）。 */
export const UPDATE_SPEC = 'docs/superpowers/specs/2026-10-02-legion-desktop-auto-update-design.md'
