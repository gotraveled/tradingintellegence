export type DataSource = "demo" | "live";

/** Every payload declares its source so the UI can label demo content. */
export interface DataEnvelope<T> {
  source: DataSource;
  data: T;
}

/** Thrown when a backend service the UI depends on is not available yet. */
export class ServiceUnavailableError extends Error {
  readonly service: string;

  constructor(service: string, message?: string) {
    super(message ?? `${service} is not connected yet.`);
    this.name = "ServiceUnavailableError";
    this.service = service;
  }
}
