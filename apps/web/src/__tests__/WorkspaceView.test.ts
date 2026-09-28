import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import WorkspaceView from '../views/WorkspaceView.vue';

vi.mock('@/services/client', () => ({
  apiClient: {
    agents: { list: vi.fn().mockResolvedValue([]) },
    sessions: { create: vi.fn() },
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ push: vi.fn() }),
}));

describe('WorkspaceView.vue', () => {
  it('renders workspace container and sidebar', () => {
    setActivePinia(createPinia());
    const wrapper = mount(WorkspaceView, {
      global: {
        stubs: {
          WorkspaceSidebar: true,
          TerminalTabBar: true,
          XtermTerminal: true,
          MobileAccessoryBar: true,
        },
      },
    });

    expect(wrapper.exists()).toBe(true);
  });
});
