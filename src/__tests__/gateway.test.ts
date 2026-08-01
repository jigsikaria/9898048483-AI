import { describe, expect, it } from 'vitest';
import { MultiKeyRotator } from '../middleware/key-rotator.ts';
import { transformStream, sseEncode, sseDone } from '../adapters/stream-transformer.ts';

describe('MultiKeyRotator', () => {
  it('round-robins across keys and quarantines failing keys', () => {
    process.env.ANTHROPIC_API_KEY = 'k1,k2,k3';
    const rotator = new MultiKeyRotator();

    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const key = rotator.next('anthropic');
      expect(key).toBeTruthy();
      seen.add(key as string);
    }
    expect(seen.size).toBe(3);

    // Simulate k1 rate-limited twice -> quarantined.
    rotator.record('anthropic', 'k1', 429);
    rotator.record('anthropic', 'k1', 429);
    expect(rotator.next('anthropic')).not.toBe('k1');
  });

  it('returns null when a provider has no keys', () => {
    delete process.env.COHERE_API_KEY;
    const rotator = new MultiKeyRotator();
    expect(rotator.next('cohere')).toBeNull();
  });
});

describe('StreamTransformer', () => {
  it('normalizes Anthropic SSE into OpenAI SSE chunks', async () => {
    const anthropicFrames = [
      sseEncode({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
      sseEncode({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }),
      sseEncode({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } }),
      sseEncode({ type: 'message_delta', usage: { input_tokens: 5, output_tokens: 7 } }),
      sseDone(),
    ];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of anthropicFrames) controller.enqueue(f);
        controller.close();
      },
    });

    const output = transformStream(source, 'anthropic', 'claude-x', 'req123');
    const reader = output.getReader();
    const text = new TextDecoder();
    const lines: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lines.push(text.decode(value));
    }

    const joined = lines.join('');
    expect(joined).toContain('"content":"Hello"');
    expect(joined).toContain('"content":" world"');
    expect(joined).toContain('"finish_reason":"stop"');
    expect(joined).toContain('"total_tokens":12');
    expect(joined).toContain('[DONE]');
  });

  it('extracts DeepSeek reasoning_content from passthrough streams', async () => {
    const frames = [
      sseEncode({ choices: [{ delta: { role: 'assistant', reasoning_content: 'think: step one' } }] }),
      sseEncode({ choices: [{ delta: { content: 'answer' } }] }),
      sseDone(),
    ];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(f);
        controller.close();
      },
    });

    const output = transformStream(source, 'deepseek', 'deepseek-reasoner', 'req456');
    const reader = output.getReader();
    const text = new TextDecoder();
    const lines: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lines.push(text.decode(value));
    }
    const joined = lines.join('');
    expect(joined).toContain('reasoning_content');
    expect(joined).toContain('"content":"answer"');
    expect(joined).toContain('[DONE]');
  });

  it('normalizes Gemini SSE (parts + finishReason + usage) into OpenAI SSE', async () => {
    const geminiFrames = [
      sseEncode({
        candidates: [{ content: { parts: [{ text: 'Gemini' }] }, finishReason: undefined }],
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2 },
      }),
      sseEncode({ candidates: [{ content: { parts: [{ text: ' reply' }] }, finishReason: 'STOP' }] }),
    ];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of geminiFrames) controller.enqueue(f);
        controller.close();
      },
    });

    const output = transformStream(source, 'gemini', 'gemini-2.0-flash-exp', 'req789');
    const reader = output.getReader();
    const text = new TextDecoder();
    const lines: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lines.push(text.decode(value));
    }
    const joined = lines.join('');
    expect(joined).toContain('"role":"assistant"');
    expect(joined).toContain('"content":"Gemini"');
    expect(joined).toContain('"content":" reply"');
    expect(joined).toContain('"finish_reason":"stop"');
    expect(joined).toContain('"total_tokens":8');
    expect(joined).toContain('[DONE]');
  });
});
