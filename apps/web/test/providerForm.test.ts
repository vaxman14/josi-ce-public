import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderForm, type ProviderCatalogEntry } from '../src/components/ProviderForm.js';

const chatgpt: ProviderCatalogEntry = {
  kind: 'openai_subscription', label: 'ChatGPT subscription', external: true,
  baseUrlMode: 'none', defaultBaseUrl: null, fields: [], discovery: 'codex',
  modelNoun: 'model', residency: '', docsUrl: '',
};

function renderForm() {
  return renderToStaticMarkup(React.createElement(ProviderForm, {
    busy: false,
    compact: true,
    catalog: [chatgpt],
    initialProvider: 'openai_subscription',
    paths: { models: '/admin/llm/models', codexBase: '/admin/llm/subscription', claudeBase: '/admin/llm/subscription/claude' },
    loadSubscriptionInfo: async () => null,
    onSubmit: async () => undefined,
    submitLabel: 'Save & test',
  }));
}

describe('ChatGPT subscription model choice', () => {
  it('shows Automatic as a visible model choice without an extra discovery button', () => {
    const html = renderForm();
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('Automatic (Codex chooses)');
    expect(html).not.toContain('Show ChatGPT models');
    expect(html).toContain('Save &amp; test');
    expect(html).toContain('exact ChatGPT model ID');
  });
});
