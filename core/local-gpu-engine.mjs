/**
 * @file local-gpu-engine.mjs
 * @description Thin ESM barrel facade for the modular Local GPU Copilot engine (core/gpu/*).
 */

export {
  resolveDefaultGpuModelsDir,
  registerBackgroundGpuController,
  preemptBackgroundGpuWork,
  getMsSinceLastForegroundGpu,
  isLocalChatActive,
  loadGpuConfig,
  classifyOllamaWorkRequest,
  beginGpuLiveWork,
  endGpuLiveWork,
  getGpuLiveActivity,
  ollamaHttpJson,
  defaultGpuTelemetry,
  getGpuTelemetry,
  destroyOllamaKeepAliveAgents,
} from './gpu/gpu-shared-state.mjs';

export {
  reconcileLoadedModelsVram,
  isOllamaEmbedModel,
  estimateModelVramMb,
  recommendPullModelForCap,
  selectBestInstalledPairForCap,
  evaluateVramModelFit,
  unloadModelsExceedingBudget,
  enforceVramCapInOllama,
  probeNvidiaGpu,
  GPU_THERMAL_THROTTLE_TEMP_C,
  GPU_EXTERNAL_BUSY_UTIL_PCT,
  evaluateGpuThermalAndLoadGuard,
  findOllamaBinary,
  buildOllamaSpawnEnv,
  buildOllamaSpawnOpts,
  ensureOllamaRunning,
  resolveOllamaManifestBlobPriority,
  warmGgufModelsInHostRam,
  unloadAllModels,
  unloadModelsOnAppExit,
  getGpuStatusSnapshot,
  getGpuPullJobStatus,
  cancelGpuPullJob,
  formatCompactPullError,
  isTransientPullError,
  pullSingleOllamaModelWithFallback,
  startGpuCascadePull,
} from './gpu/gpu-vram-runtime.mjs';

export {
  computeSafeNumCtx,
  distillText,
  decodeTextBufferAutoUtf,
  distillLocalFile,
} from './gpu/gpu-distill.mjs';

export {
  quantizeUnitToInt8,
  dotProductPrefix,
  dotProductUnit,
  formatEmbedInput,
  embedTexts,
  chunkFileForVectors,
  getVectorStorePaths,
  saveWorkspaceVectorStore,
  loadWorkspaceVectorStore,
  indexWorkspaceVectors,
  indexSingleFileVector,
  semanticSearchWorkspace,
  ensureEmbedModelWarm,
  peekWarmSemanticTargets,
  discoverSkillSemanticEntries,
  indexSkillVectors,
  scoreSkillVectorsWithQueryVec,
  peekWarmSemanticBundle,
  peekWarmSemanticSkills,
  classifySkillWithLlm,
  matchSkillsAi,
} from './gpu/gpu-vector-skills.mjs';

export {
  isCompletedSentenceDraft,
  isAssistantAnswerContinuation,
  sanitizeGhostContinuation,
  verifyGhostContinuationGrounding,
  generatePromptContinuation,
  analyzeUiScreenshotLocally,
  generateLocalCommitSummary,
  structureVoiceTranscriptLocally,
} from './gpu/gpu-composer-copilot.mjs';

export {
  scanAddedIdentifiersForRefBugs,
  critiqueEditedDiffLocally,
  auditLocalChatAnswerGrounding,
  verifyChatClaimsLocally,
  runLocalProjectChat,
  generateIdleModuleSymbolCard,
  reviewGitDiffHunkLocally,
} from './gpu/gpu-critic-chat.mjs';
