# Dependency Audit Report

**Date:** 2026-01-14
**Total node_modules size:** 843MB
**Total packages:** 243

## Summary

| Category | Status |
|----------|--------|
| Security Vulnerabilities | None found |
| Outdated Packages | 5 packages |
| Bloat Concerns | High (843MB, mostly from node-llama-cpp) |

---

## 1. Outdated Packages

| Package | Current | Latest | Severity | Recommendation |
|---------|---------|--------|----------|----------------|
| `@anthropic-ai/sdk` | 0.36.3 | 0.71.2 | **High** | Update - major version behind |
| `openai` | 4.104.0 | 6.16.0 | **High** | Update - major version behind (v6) |
| `@google/generative-ai` | 0.21.0 | 0.24.1 | Medium | Update - minor version behind |
| `uuid` | 11.1.0 | 13.0.0 | **High** | Consider removing entirely (see below) |
| `@types/uuid` | 10.0.0 | 11.0.0 | Low | Update with uuid or remove |

### Critical Updates Needed

1. **`openai` ^4.77.0 → ^6.16.0**
   - Major API changes in v6
   - Review breaking changes before upgrading
   - New streaming API, improved TypeScript types

2. **`@anthropic-ai/sdk` ^0.36.3 → ^0.71.2**
   - Significant version jump (35+ minor versions)
   - May include new model support, API improvements
   - Review changelog for breaking changes

---

## 2. Security Vulnerabilities

**Status:** No vulnerabilities found via `npm audit`

---

## 3. Dependency Bloat Analysis

### Largest Dependencies

| Package | Size | Notes |
|---------|------|-------|
| `@node-llama-cpp/*` | 703MB | Platform binaries (expected) |
| `node-llama-cpp` | 31MB | Main package |
| `better-sqlite3` | 27MB | Native addon |
| `typescript` | 23MB | Dev dependency (expected) |
| `js-tiktoken` | 22MB | Token counting |
| `@octokit/*` | 11MB | **Transitive - not directly used** |
| `openai` | 4.7MB | Core dependency |

### Key Findings

#### 1. `node-llama-cpp` brings heavy transitive dependencies (734MB total)
- **@octokit** (11MB) - GitHub API client for model downloads
- **simple-git** (1.1MB) - Git operations
- **cmake-js** - Native build tooling

This is expected for a local LLM runtime but makes the package heavy.

#### 2. `uuid` package is unnecessary
The `uuid` package (216KB) can be replaced with native `crypto.randomUUID()` available in:
- Node.js 14.17.0+
- Bun (all versions)
- All modern browsers

Current usage in `src/usage/logger.ts` already has a fallback, making the package redundant.

#### 3. `js-tiktoken` is heavy (22MB)
Contains WASM binaries for accurate OpenAI tokenization. Consider:
- Making it optional (lazy-load only when needed)
- Using approximate token counting for non-OpenAI models

---

## 4. Recommendations

### Immediate Actions

#### 4.1 Remove `uuid` dependency (Save 216KB + simplify)

Replace with native `crypto.randomUUID()`:

```typescript
// Before (src/usage/logger.ts)
const uuid = await import('uuid');
uuidv4 = uuid.v4;

// After
uuidv4 = () => crypto.randomUUID();
```

**package.json changes:**
```diff
  "dependencies": {
-   "uuid": "^11.0.3"
  },
  "devDependencies": {
-   "@types/uuid": "^10.0.0",
  }
```

#### 4.2 Update SDK versions

```diff
  "dependencies": {
-   "openai": "^4.77.0",
+   "openai": "^6.16.0",
-   "@anthropic-ai/sdk": "^0.36.3",
+   "@anthropic-ai/sdk": "^0.71.2",
-   "@google/generative-ai": "^0.21.0",
+   "@google/generative-ai": "^0.24.1",
  }
```

**Warning:** Review breaking changes in openai v6 before upgrading.

### Medium-Term Actions

#### 4.3 Make `node-llama-cpp` truly optional

Currently in `optionalDependencies`, but its 734MB footprint impacts all installs. Consider:

1. Moving to a separate package (`unified-llm-local`)
2. Documenting manual installation for local LLM support
3. Using peer dependencies instead

#### 4.4 Lazy-load heavy tokenizers

Only load `js-tiktoken` when actually counting tokens for OpenAI models:

```typescript
// Current: Always imported
import * as tiktoken from 'js-tiktoken';

// Better: Dynamic import when needed
const tiktoken = await import('js-tiktoken');
```

### Low Priority

#### 4.5 Pin @types/bun version
Currently using `"latest"` which is unpredictable:

```diff
  "devDependencies": {
-   "@types/bun": "latest",
+   "@types/bun": "^1.3.6",
  }
```

---

## 5. Proposed package.json

```json
{
  "dependencies": {
    "openai": "^6.16.0",
    "@anthropic-ai/sdk": "^0.71.2",
    "@google/generative-ai": "^0.24.1"
  },
  "optionalDependencies": {
    "node-llama-cpp": "^3.15.0",
    "better-sqlite3": "^12.6.0",
    "js-tiktoken": "^1.0.21",
    "llama-tokenizer-js": "^1.2.2"
  },
  "devDependencies": {
    "@types/bun": "^1.3.6",
    "@types/better-sqlite3": "^7.6.13",
    "typescript": "^5.9.3"
  }
}
```

**Changes:**
- Removed `uuid` and `@types/uuid` (use native crypto.randomUUID)
- Updated all SDK versions to latest
- Pinned @types/bun version

---

## 6. Size Impact Estimate

| Change | Savings |
|--------|---------|
| Remove uuid + @types/uuid | ~220KB |
| Keep node-llama-cpp optional | 734MB (for users who don't need local LLMs) |

**Note:** Most of the 843MB comes from `node-llama-cpp` platform binaries which are necessary for local LLM inference. This is unavoidable if local model support is required.
