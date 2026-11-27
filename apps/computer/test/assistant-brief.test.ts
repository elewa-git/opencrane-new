import { expect, it } from 'vitest';
import { renderSoul } from '../src/assistant-brief.ts';
import { memoryFreeConfig } from '../src/codex-config.ts';

function usesApprovedPersona() {
  const persona = 'Your name is Willow. Speak warmly and briefly. Value careful, honest work.';
  const soul = renderSoul(persona);
  expect(soul).toContain(persona);
  expect(soul).toContain('identity, name, voice and values');
  expect(soul).not.toContain('You are Codex');
  expect(soul).toContain('apply_patch');
  expect(soul).toContain('shell');
  expect(soul).toContain('plan');
}
it('builds the assistant identity from the approved onboarding persona', usesApprovedPersona);

function usesPlainDefault() {
  const soul = renderSoul();
  expect(soul).toContain('You are a helpful assistant');
  expect(soul).not.toContain('You are Codex');
  expect(soul).not.toContain('undefined');
  expect(soul).toContain('Apache License');
}
it('uses a plain assistant identity without a persona and keeps the source notice', usesPlainDefault);

function replacesTheBuiltInInstructions() {
  const config = memoryFreeConfig('test-model');
  expect(config).toContain('model_instructions_file = ');
  expect(config).toContain('personality = "none"');
  expect(config).toContain('project_doc_max_bytes = 0');
  expect(config).toContain('personal assistant');
}
it('replaces the built-in identity without enabling project documents',
  replacesTheBuiltInInstructions);
