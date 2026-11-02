// @vitest-environment happy-dom
// AC-SV2-35 (Spec_Sources_V2 §10 DOM tests): the console has a third tab, Jobs (tab-jobs / pane-jobs), mounted with the others; the
// active prop tells SourcesTab and JobsTab which one is showing. The three tabs are stubs that render their props.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({ default: (p: { href: string; children?: unknown }) => createElement('a', { href: p.href }, p.children as never) }));
vi.mock('./QueueTab', () => ({ default: () => createElement('div', { 'data-stub': 'queue' }, 'queue stub') }));
vi.mock('./SourcesTab', () => ({
  default: (p: { active?: boolean }) => createElement('div', { 'data-stub': 'sources' }, `sources active=${String(p.active)}`),
}));
vi.mock('./JobsTab', () => ({
  default: (p: { active?: boolean }) => createElement('div', { 'data-stub': 'jobs' }, `jobs active=${String(p.active)}`),
}));

import Console from './Console';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let box: HTMLElement;
async function mount() {
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  await act(async () => { root!.render(createElement(Console, { onForbidden: () => {}, onSignOut: () => {} })); });
}
const stub = (k: string) => box.querySelector(`[data-stub="${k}"]`)?.textContent ?? null;
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  box?.remove();
});

describe('AC-SV2-35 Console: the Jobs tab', () => {
  it('has three tabs, all panels mounted; Jobs starts inactive', async () => {
    await mount();
    const tabs = [...box.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.id)).toEqual(['tab-queue', 'tab-sources', 'tab-jobs']);
    const jobsTab = box.querySelector('#tab-jobs')!;
    expect(jobsTab.textContent).toBe('Jobs');
    expect(jobsTab.getAttribute('aria-controls')).toBe('pane-jobs');
    expect(jobsTab.getAttribute('aria-selected')).toBe('false');
    const pane = box.querySelector<HTMLElement>('#pane-jobs');
    expect(pane, 'pane-jobs').not.toBeNull();
    expect(pane!.getAttribute('role')).toBe('tabpanel');
    expect(pane!.getAttribute('aria-labelledby')).toBe('tab-jobs');
    expect(pane!.hidden).toBe(true);
    expect(stub('jobs')).toBe('jobs active=false');
    expect(stub('sources')).toBe('sources active=false');
    expect(stub('queue')).toBe('queue stub');
  });

  it('clicking Jobs selects it, shows pane-jobs, and passes active true to Jobs and false to Sources', async () => {
    await mount();
    const jb = box.querySelector<HTMLButtonElement>('#tab-jobs');
    expect(jb, 'tab-jobs button').not.toBeNull();
    await act(async () => { jb!.click(); });
    expect(box.querySelector('#tab-jobs')!.getAttribute('aria-selected')).toBe('true');
    expect(box.querySelector('#tab-queue')!.getAttribute('aria-selected')).toBe('false');
    expect(box.querySelector<HTMLElement>('#pane-jobs')!.hidden).toBe(false);
    expect(box.querySelector<HTMLElement>('#pane-queue')!.hidden).toBe(true);
    expect(box.querySelector<HTMLElement>('#pane-sources')!.hidden).toBe(true);
    expect(stub('jobs')).toBe('jobs active=true');
    expect(stub('sources')).toBe('sources active=false');

    await act(async () => { box.querySelector<HTMLButtonElement>('#tab-sources')!.click(); });
    expect(stub('jobs')).toBe('jobs active=false');
    expect(stub('sources')).toBe('sources active=true');
    expect(box.querySelector('[data-stub="jobs"]'), 'Jobs stays mounted').not.toBeNull();
  });
});
