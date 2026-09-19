import { describe, expect, it } from "vitest";
import {
  TYPESAFE_SYSTEM_ONE_ENDPOINT,
  TypeSafeHttpError,
  createTypeSafeHttpTransport,
} from "../src/evaluation/typesafe-http.js";

const request = (
  overrides: Partial<Parameters<ReturnType<typeof createTypeSafeHttpTransport>["send"]>[0]> = {},
) => ({
  body: '{"state":"bounded"}',
  apiKey: "test-secret",
  timeoutMs: 1_000,
  responseMaxUtf8Bytes: 64 * 1024,
  ...overrides,
});

describe("native TypeSafe HTTP adapter", () => {
  it("uses the fixed endpoint with one no-redirect POST and no adapter retry", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response('{"model":"jev-1.13.0"}', { status: 200 });
    };
    const transport = createTypeSafeHttpTransport({ fetchImpl });

    await expect(transport.send(request())).resolves.toEqual({
      status: 200,
      body: '{"model":"jev-1.13.0"}',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      input: TYPESAFE_SYSTEM_ONE_ENDPOINT,
      init: {
        method: "POST",
        redirect: "error",
        body: '{"state":"bounded"}',
        headers: {
          Authorization: "Bearer test-secret",
          "Content-Type": "application/json",
        },
        signal: expect.any(AbortSignal),
      },
    });
  });

  it("labels an injected fetch as scripted evidence", () => {
    const transport = createTypeSafeHttpTransport({
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });

    expect(transport.evidenceSource).toBe("scripted");
  });

  it("labels the standard non-injected adapter as native API evidence", () => {
    expect(createTypeSafeHttpTransport().evidenceSource).toBe("native-api");
  });

  it("returns a bounded HTTP error response once so usage can be projected", async () => {
    let calls = 0;
    const body = '{"error":"slow down","usage":{"input_tokens":12,"output_tokens":0}}';
    const transport = createTypeSafeHttpTransport({
      fetchImpl: async () => {
        calls++;
        return new Response(body, { status: 429 });
      },
    });

    await expect(transport.send(request())).resolves.toEqual({ status: 429, body });
    expect(calls).toBe(1);
  });

  it("aborts and cancels a response stream as soon as its body exceeds the bound", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const transport = createTypeSafeHttpTransport({
      fetchImpl: async () => new Response(body, { status: 200 }),
    });

    await expect(transport.send(request({ responseMaxUtf8Bytes: 5 }))).rejects.toMatchObject({
      code: "response-too-large",
    });
    expect(cancelled).toBe(true);
  });

  it("rejects an oversized declared content length and cancels the body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const transport = createTypeSafeHttpTransport({
      fetchImpl: async () =>
        new Response(body, { status: 200, headers: { "content-length": "100" } }),
    });

    await expect(transport.send(request({ responseMaxUtf8Bytes: 5 }))).rejects.toMatchObject({
      code: "response-too-large",
    });
    expect(cancelled).toBe(true);
  });

  it("aborts an outstanding fetch at the cooperative deadline", async () => {
    const fetchImpl: typeof fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("test fetch requires a signal");
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const transport = createTypeSafeHttpTransport({ fetchImpl });

    await expect(transport.send(request({ timeoutMs: 1 }))).rejects.toMatchObject({
      code: "deadline",
    });
  });

  it("propagates caller cancellation and aborts the outstanding fetch", async () => {
    const caller = new AbortController();
    const fetchImpl: typeof fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("test fetch requires a signal");
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        caller.abort(new DOMException("cancelled", "AbortError"));
      });
    const transport = createTypeSafeHttpTransport({ fetchImpl });

    await expect(transport.send(request({ signal: caller.signal }))).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects invalid UTF-8 after the bounded read", async () => {
    const transport = createTypeSafeHttpTransport({
      fetchImpl: async () => new Response(new Uint8Array([0xc3, 0x28]), { status: 200 }),
    });

    await expect(transport.send(request())).rejects.toEqual(
      new TypeSafeHttpError("invalid-utf8", "TypeSafe response body is not valid UTF-8"),
    );
  });
});
