/**
 * 驱动内部的事件通道：后台 pump 推入事件，调用方以 AsyncIterable 消费。
 * 消费方提前退出（break / return）时触发 onCancel，用于结束 harness 进程。
 */
export interface EventChannel<T> extends AsyncIterable<T> {
  push(item: T): void;
  close(): void;
  fail(error: unknown): void;
}

export function createEventChannel<T>(onCancel: () => void): EventChannel<T> {
  const items: T[] = [];
  let done = false;
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  return {
    push(item) {
      if (done) return;
      items.push(item);
      notify();
    },
    close() {
      done = true;
      notify();
    },
    fail(error) {
      if (done) return;
      failure = { error };
      done = true;
      notify();
    },
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          while (true) {
            if (items.length > 0) return { value: items.shift() as T, done: false };
            if (failure) throw failure.error;
            if (done) return { value: undefined, done: true };
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
        async return(): Promise<IteratorResult<T>> {
          if (!done) {
            done = true;
            onCancel();
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/** abort 时立即拒绝，避免审批等待阻塞取消。 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "Aborted");
  error.name = "AbortError";
  return error;
}
