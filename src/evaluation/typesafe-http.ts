export const TYPESAFE_SYSTEM_ONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone" as const;

export type JevTransportEvidenceSource = "native-api" | "scripted";

export interface JevTransportRequest {
  readonly body: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly responseMaxUtf8Bytes: number;
  readonly signal?: AbortSignal;
}

export interface JevTransportResponse {
  readonly status: number;
  readonly body: string;
}

export interface JevTransport {
  readonly evidenceSource: JevTransportEvidenceSource;
  send(request: JevTransportRequest): Promise<JevTransportResponse>;
}

export type TypeSafeHttpErrorCode =
  | "credential"
  | "deadline"
  | "network"
  | "http-status"
  | "response-too-large"
  | "invalid-utf8";

export class TypeSafeHttpError extends Error {
  readonly code: TypeSafeHttpErrorCode;
  readonly status?: number;

  constructor(code: TypeSafeHttpErrorCode, message: string, status?: number) {
    super(message);
    this.name = "TypeSafeHttpError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

interface TypeSafeHttpDependencies {
  readonly fetchImpl?: typeof fetch;
}

const callerAbortReason = (signal: AbortSignal): Error => {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
};

const readWithAbort = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};

const boundedBody = async (
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    const error = new TypeSafeHttpError(
      "response-too-large",
      `TypeSafe response declares ${contentLength} bytes; maximum is ${maxBytes}`,
    );
    controller.abort(error);
    if (response.body) await response.body.cancel(error).catch(() => undefined);
    throw error;
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await readWithAbort(reader.read(), controller.signal);
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        const error = new TypeSafeHttpError(
          "response-too-large",
          `TypeSafe response exceeded the ${maxBytes}-byte maximum`,
        );
        controller.abort(error);
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeSafeHttpError("invalid-utf8", "TypeSafe response body is not valid UTF-8");
  }
};

export const createTypeSafeHttpTransport = (
  dependencies: TypeSafeHttpDependencies = {},
): JevTransport => {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  return {
    evidenceSource: "native-api",
    async send(request): Promise<JevTransportResponse> {
      if (request.apiKey.length === 0) {
        throw new TypeSafeHttpError("credential", "TypeSafe API key is unavailable");
      }
      if (request.signal?.aborted) throw callerAbortReason(request.signal);
      if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
        throw new TypeSafeHttpError("deadline", "TypeSafe request deadline expired");
      }

      const controller = new AbortController();
      let deadlineExpired = false;
      const deadlineError = new TypeSafeHttpError(
        "deadline",
        "TypeSafe request exceeded the cooperative deadline",
      );
      const timer = setTimeout(() => {
        deadlineExpired = true;
        controller.abort(deadlineError);
      }, request.timeoutMs);
      const onCallerAbort = (): void => {
        if (request.signal) controller.abort(callerAbortReason(request.signal));
      };
      request.signal?.addEventListener("abort", onCallerAbort, { once: true });

      try {
        const response = await fetchImpl(TYPESAFE_SYSTEM_ONE_ENDPOINT, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${request.apiKey}`,
            "Content-Type": "application/json",
          },
          body: request.body,
          signal: controller.signal,
        });
        const body = await boundedBody(response, request.responseMaxUtf8Bytes, controller);
        if (!response.ok) {
          throw new TypeSafeHttpError(
            "http-status",
            `TypeSafe returned HTTP ${response.status}`,
            response.status,
          );
        }
        return { status: response.status, body };
      } catch (error) {
        if (request.signal?.aborted) throw callerAbortReason(request.signal);
        if (deadlineExpired) throw deadlineError;
        if (error instanceof TypeSafeHttpError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new TypeSafeHttpError("network", `TypeSafe request failed: ${detail}`);
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
};
