declare const Bun: {
  serve(options: { port: number; hostname: string; fetch: unknown }): unknown;
} | undefined;

interface ImportMeta {
  readonly url: string;
  readonly main: boolean;
}
