/**
 * Official JavaScript/TypeScript SDK for the WellMarked API.
 *
 *     import { WellMarked } from "wellmarked";
 *
 *     const wm = new WellMarked({ apiKey: "wm_..." });
 *     const result = await wm.extract("https://example.com/article");
 *     console.log(result.markdown);
 *
 * See https://wellmarked.io/docs for the full API reference.
 */
export { VERSION } from "./version.js";
export {
  WellMarked,
  type WellMarkedOptions,
  type ExtractOptions,
  type SearchOptions,
  type BulkOptions,
  type CrawlOptions,
  type JobWebhookOptions,
  type PolicyOverrideOptions,
  type CreateKeyOptions,
  type GetLogsOptions,
  type RegisterOptions,
  type WaitForJobOptions,
} from "./client.js";
export {
  verifyWebhook,
  WebhookVerificationError,
  type VerifyWebhookOptions,
  type WebhookPayload,
} from "./webhooks.js";
export {
  type ApiKeyInfo,
  type BulkItem,
  type BulkJob,
  type CrawlItem,
  type CrawlJob,
  type CreatedKey,
  type ExtractionMeta,
  type ExtractResult,
  type JobStatus,
  type LogEntry,
  type LogsPage,
  type RegisteredAccount,
  type RevokedKey,
  type RotatedKey,
  type RotatedWebhookSecret,
  type SearchResult,
  type SearchResults,
  type TruncatedReason,
  type Usage,
  isBulkJob,
  isCrawlJob,
} from "./models.js";
export {
  APIConnectionError,
  APIStatusError,
  AuthenticationError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
  WellMarkedError,
} from "./errors.js";
