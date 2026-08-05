declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    fetch: (
      request: Request,
      server: { requestIP?(request: Request): { address: string } | null },
    ) => Promise<Response> | Response;
  }): unknown;
} | undefined;

interface ImportMeta {
  readonly url: string;
  readonly main: boolean;
}
